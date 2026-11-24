#!/usr/bin/env node
// Send a WhatsApp "sticker with sound" (audioStickerMessage, Message field 134) using Baileys.
//
// Wire shape (reverse-engineered by the community, not official):
//   Message {
//     messageContextInfo { messageSecret: 32 random bytes }
//     [134] audioStickerMessage: FutureProofMessage {
//       [1] message: Message {
//         [26] stickerMessage: StickerMessage {
//           ...normal uploaded WebP sticker fields...
//           [26] audioMessage: AudioMessage { ...uploaded Ogg/Opus, no ptt, streamingSidecar... }
//         }
//       }
//     }
//   }
// Baileys' bundled protobuf schema does not know field 134 or StickerMessage field 26,
// so we encode those two layers by hand and splice them in when Baileys encodes the message.
//
// Usage:
//   node audio-sticker.mjs build <image|gif|video> <audio> [--seconds 10]
//   node audio-sticker.mjs send  <image|gif|video> <audio> --to <number|jid> [--seconds 10]
//                                [--stanza text|media] [--pair <your number>] [--auth ./auth]

import { execFile } from 'node:child_process'
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
	Browsers,
	DisconnectReason,
	default as makeWASocket,
	getMediaKeys,
	prepareWAMessageMedia,
	proto,
	useMultiFileAuthState
} from 'baileys'
import pino from 'pino'
import sharp from 'sharp'
import qrcode from 'qrcode-terminal'

const run = promisify(execFile)
const MAX_STICKER_BYTES = 1024 * 1024 // WhatsApp rejects stickers over ~1 MB

const TAG_STICKER_AUDIO = (26 << 3) | 2 // StickerMessage.audioMessage
const TAG_AUDIO_STICKER = (134 << 3) | 2 // Message.audioStickerMessage
const TAG_FP_MESSAGE = (1 << 3) | 2 // FutureProofMessage.message
const TAG_MSG_STICKER = (26 << 3) | 2 // Message.stickerMessage

// ---------- protobuf helpers ----------

const varint = n => {
	const out = []
	while (n > 127) {
		out.push((n & 0x7f) | 0x80)
		n >>>= 7
	}
	out.push(n)
	return Buffer.from(out)
}
const lengthDelimited = (tag, bytes) => Buffer.concat([varint(tag), varint(bytes.length), Buffer.from(bytes)])

// Extra fields seen on a real audio sticker sent by the official iOS app that Baileys' schema lacks:
//   AudioMessage.contextInfo[17] -> field 74 { 1: 1, 2: <the audio's own mediaKey> }
//   StickerMessage field 24 = 0
const audioContextExtra = mediaKey =>
	lengthDelimited((17 << 3) | 2, lengthDelimited((74 << 3) | 2, Buffer.concat([Buffer.from([0x08, 0x01]), lengthDelimited((2 << 3) | 2, mediaKey)])))
const STICKER_FIELD_24 = Buffer.from([0xc0, 0x01, 0x00])

/** Bytes of FutureProofMessage{ message: { stickerMessage: { ...sticker, audioMessage } } } */
export function encodeAudioStickerWrapper(stickerMessage, audioMessage) {
	const { contextInfo: _ignored, ...audio } = audioMessage
	const audioBytes = Buffer.concat([
		proto.Message.AudioMessage.encode(audio).finish(),
		audio.mediaKey ? audioContextExtra(Buffer.from(audio.mediaKey)) : Buffer.alloc(0)
	])
	const stickerBytes = Buffer.concat([
		proto.Message.StickerMessage.encode(stickerMessage).finish(),
		STICKER_FIELD_24,
		lengthDelimited(TAG_STICKER_AUDIO, audioBytes)
	])
	const innerMessage = lengthDelimited(TAG_MSG_STICKER, stickerBytes)
	return lengthDelimited(TAG_FP_MESSAGE, innerMessage)
}

/**
 * WhatsApp's streaming sidecar: one 10-byte HMAC per 64 KiB window of (iv || ciphertext || mac),
 * each window extended by 16 bytes. withMac=false drops the trailing mac from the stream.
 */
export async function computeSidecar(encFile, mediaKey, mediaType = 'audio', withMac = true) {
	const { iv, macKey } = await getMediaKeys(mediaKey, mediaType)
	const stream = Buffer.concat([iv, withMac ? encFile : encFile.subarray(0, encFile.length - 10)])
	const out = []
	for (let i = 0; i < stream.length; i += 65536) {
		out.push(createHmac('sha256', macKey).update(stream.subarray(i, i + 65536 + 16)).digest().subarray(0, 10))
	}
	return Buffer.concat(out)
}

/** Re-create the encrypted upload (deterministic for a given mediaKey) so we can sign it. */
export async function encryptMedia(plain, mediaKey, mediaType = 'audio') {
	const { iv, cipherKey, macKey } = await getMediaKeys(mediaKey, mediaType)
	const aes = createCipheriv('aes-256-cbc', cipherKey, iv)
	const cipher = Buffer.concat([aes.update(plain), aes.final()])
	const mac = createHmac('sha256', macKey).update(iv).update(cipher).digest().subarray(0, 10)
	return Buffer.concat([cipher, mac])
}

// Messages carrying this symbol get field 134 appended when Baileys encodes them.
const RAW_134 = Symbol('audioStickerMessage')
const MEDIA_STANZA = Symbol('mediaStanza')
const originalEncode = proto.Message.encode
proto.Message.encode = function encode(m, w) {
	const writer = originalEncode.call(this, m, w)
	if (m && m[RAW_134]) writer.uint32(TAG_AUDIO_STICKER).bytes(m[RAW_134])
	return writer
}

/**
 * The message object to hand to sock.relayMessage().
 * mediaStanza=true makes Baileys label the stanza type="media" + mediatype="sticker"
 * (via a non-own getter it reads but the encoder ignores); otherwise it goes as type="text".
 */
export function buildAudioStickerMessage(stickerMessage, audioMessage, { mediaStanza = false } = {}) {
	const proto_ = mediaStanza ? { get stickerMessage() { return { [MEDIA_STANZA]: true } } } : Object.prototype
	const msg = Object.create(proto_)
	msg.messageContextInfo = { messageSecret: randomBytes(32) }
	msg[RAW_134] = encodeAudioStickerWrapper(stickerMessage, audioMessage)
	return msg
}

// ---------- media conversion ----------

async function probe(file) {
	const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,nb_frames', '-of', 'json', file])
	const info = JSON.parse(stdout)
	const video = info.streams?.find(s => s.codec_type === 'video')
	const duration = Number(info.format?.duration) || 0
	const frames = Number(video?.nb_frames) || 0
	return { duration, hasVideo: !!video, animated: !!video && (frames > 1 || (frames === 0 && duration > 0.2)) }
}

async function toWebp(input, workdir) {
	const { animated } = await probe(input)
	const scale = 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000'
	const attempts = animated
		? [{ q: 50, fps: 15, t: 10 }, { q: 30, fps: 10, t: 8 }, { q: 20, fps: 8, t: 6 }, { q: 10, fps: 6, t: 4 }]
		: [{ q: 80 }, { q: 50 }, { q: 25 }]
	// ffmpeg only resizes/decodes into formats every build has (PNG / GIF); WebP encoding is done
	// by sharp, because many ffmpeg builds (e.g. Homebrew's) ship without libwebp.
	for (const [i, a] of attempts.entries()) {
		const mid = path.join(workdir, `frame${i}.${animated ? 'gif' : 'png'}`)
		const args = animated
			? ['-y', '-i', input, '-t', String(a.t), '-an', '-vf',
				`${scale},fps=${a.fps},split[s0][s1];[s0]palettegen=reserve_transparent=1[p];[s1][p]paletteuse`, '-loop', '0', mid]
			: ['-y', '-i', input, '-an', '-frames:v', '1', '-update', '1', '-vf', scale, mid]
		await run('ffmpeg', ['-v', 'error', ...args])
		const out = path.join(workdir, `sticker${i}.webp`)
		await sharp(mid, { animated }).webp({ quality: a.q, loop: 0, effort: 6 }).toFile(out)
		const buf = await readFile(out)
		if (buf.length <= MAX_STICKER_BYTES) return { buffer: buf, animated, file: out }
	}
	throw new Error('Could not get the sticker under 1 MB; use a shorter/smaller input')
}

async function toOggOpus(input, workdir, maxSeconds) {
	const out = path.join(workdir, 'sound.ogg')
	// -vbr/-compression_level/-frame_duration/-avoid_negative_ts: without them phones show the
	// sticker but refuse to play its sound (per the zapota implementation).
	await run('ffmpeg', ['-v', 'error', '-y', '-i', input, '-vn', '-t', String(maxSeconds),
		'-ar', '16000', '-ac', '1', '-c:a', 'libopus', '-b:a', '32k', '-vbr', 'on', '-compression_level', '10',
		'-frame_duration', '20', '-application', 'voip', '-avoid_negative_ts', 'make_zero', '-map_metadata', '-1',
		'-f', 'ogg', out])
	const { duration } = await probe(out)
	const { stdout: pcm } = await run('ffmpeg', ['-v', 'error', '-i', out, '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'],
		{ encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
	return { buffer: await readFile(out), seconds: Math.min(maxSeconds, Math.max(1, Math.ceil(duration))), waveform: waveformFromPcm(pcm), file: out }
}

function waveformFromPcm(pcm, bars = 64) {
	const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2))
	const size = Math.max(1, Math.floor(samples.length / bars))
	const peaks = Array.from({ length: bars }, (_, b) => {
		let sum = 0
		for (let i = b * size; i < Math.min((b + 1) * size, samples.length); i++) sum += Math.abs(samples[i])
		return sum / size
	})
	const max = Math.max(...peaks) || 1
	return new Uint8Array(peaks.map(p => Math.round((p / max) * 100)))
}

export async function prepareFiles(visual, audio, seconds, workdir) {
	const [sticker, sound] = await Promise.all([toWebp(visual, workdir), toOggOpus(audio, workdir, seconds)])
	return { sticker, sound }
}

// ---------- WhatsApp ----------

function connect(authDir, pairNumber) {
	return new Promise(async (resolve, reject) => {
		const { state, saveCreds } = await useMultiFileAuthState(authDir)
		const sock = makeWASocket({ auth: state, logger: pino({ level: 'warn' }), browser: Browsers.macOS('Chrome') })
		sock.ev.on('creds.update', saveCreds)
		let pairingRequested = false
		sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
			if (qr) {
				if (pairNumber && !pairingRequested) {
					pairingRequested = true
					const code = await sock.requestPairingCode(pairNumber.replace(/\D/g, ''))
					console.log(`\nPairing code: ${code}\nWhatsApp > Linked devices > Link with phone number instead\n`)
				} else if (!pairNumber) {
					console.log('\nScan this QR with WhatsApp > Linked devices:\n')
					qrcode.generate(qr, { small: true })
				}
			}
			if (connection === 'open') resolve(sock)
			if (connection === 'close') {
				const code = lastDisconnect?.error?.output?.statusCode
				if (code === DisconnectReason.restartRequired) {
					resolve(connect(authDir, pairNumber)) // normal right after first login
				} else {
					reject(lastDisconnect?.error ?? new Error('connection closed'))
				}
			}
		})
	})
}

const toJid = to => (to.includes('@') ? to : `${to.replace(/\D/g, '')}@s.whatsapp.net`)

async function send({ visual, audio, to, seconds, stanza, pair, auth, disappear }, workdir) {
	const { sticker, sound } = await prepareFiles(visual, audio, seconds, workdir)
	console.log(`sticker ${sticker.buffer.length} B (animated=${sticker.animated}), sound ${sound.buffer.length} B, ${sound.seconds}s`)

	const sock = await connect(auth, pair)
	const upload = sock.waUploadToServer
	const { stickerMessage } = await prepareWAMessageMedia({ sticker: sticker.buffer }, { upload })
	// The official app sends the sticker's audio as plain audio: no ptt flag, no waveform.
	const { audioMessage } = await prepareWAMessageMedia(
		{ audio: sound.buffer, mimetype: 'audio/ogg; codecs=opus', ptt: false, seconds: sound.seconds },
		{ upload }
	)
	delete audioMessage.ptt
	delete audioMessage.waveform
	const enc = await encryptMedia(sound.buffer, audioMessage.mediaKey)
	if (!createHash('sha256').update(enc).digest().equals(Buffer.from(audioMessage.fileEncSha256))) {
		throw new Error('re-encrypted audio does not match the upload; cannot compute sidecar')
	}
	audioMessage.streamingSidecar = await computeSidecar(enc, audioMessage.mediaKey)
	stickerMessage.stickerSentTs = Date.now()
	stickerMessage.isAvatar = false
	stickerMessage.isAiSticker = false
	stickerMessage.isLottie = false
	stickerMessage.accessibilityLabel = ''
	stickerMessage.isAnimated = sticker.animated
	stickerMessage.width = 512
	stickerMessage.height = 512
	// Disappearing-messages chats: the timer must be copied into the sticker or it never disappears.
	const expiration = { '24h': 86400, '7d': 604800, '90d': 7776000 }[disappear] ?? (Number(disappear) || 0)
	if (expiration) stickerMessage.contextInfo = { ...stickerMessage.contextInfo, expiration }

	const jid = toJid(to)
	const message = buildAudioStickerMessage(stickerMessage, audioMessage, { mediaStanza: stanza === 'media' })
	const id = await sock.relayMessage(jid, message, {})
	console.log(`sent ${id} to ${jid} (stanza ${stanza === 'media' ? 'type=media mediatype=sticker' : 'type=text'})`)
	await new Promise(r => setTimeout(r, 3000)) // let acks flush
	sock.end(undefined)
}

// ---------- listen: capture real audio stickers sent by the official app ----------

function readVarint(buf, pos) {
	let result = 0, shift = 0, byte
	do {
		if (pos >= buf.length) throw new Error('truncated varint')
		byte = buf[pos++]
		result += (byte & 0x7f) * 2 ** shift
		shift += 7
	} while (byte & 0x80)
	return [result, pos]
}

/** Parse raw protobuf without a schema. Returns null if the bytes are not a valid message. */
function parseRaw(buf) {
	const fields = []
	let pos = 0
	try {
		while (pos < buf.length) {
			let tag
			;[tag, pos] = readVarint(buf, pos)
			const field = Math.floor(tag / 8), wire = tag & 7
			if (field === 0) return null
			if (wire === 0) { let v; [v, pos] = readVarint(buf, pos); fields.push({ field, wire, value: v }) }
			else if (wire === 1) { fields.push({ field, wire, value: buf.subarray(pos, pos + 8) }); pos += 8 }
			else if (wire === 5) { fields.push({ field, wire, value: buf.subarray(pos, pos + 4) }); pos += 4 }
			else if (wire === 2) {
				let len
				;[len, pos] = readVarint(buf, pos)
				if (pos + len > buf.length) return null
				fields.push({ field, wire, value: buf.subarray(pos, pos + len) })
				pos += len
			} else return null
		}
	} catch { return null }
	return pos === buf.length ? fields : null
}

function dumpRaw(buf, indent = '') {
	const lines = []
	for (const { field, wire, value } of parseRaw(buf) ?? []) {
		if (wire !== 2) { lines.push(`${indent}${field}: ${wire === 0 ? value : Buffer.from(value).toString('hex')}`); continue }
		const text = Buffer.from(value).toString('utf8')
		const printable = value.length > 0 && /^[\x20-\x7e]+$/.test(text)
		const nested = !printable && value.length > 1 ? parseRaw(value) : null
		if (nested?.length) {
			lines.push(`${indent}${field} {`, dumpRaw(value, indent + '  '), `${indent}}`)
		} else if (printable) {
			lines.push(`${indent}${field}: "${text.length > 200 ? text.slice(0, 200) + '…' : text}"`)
		} else {
			const hex = Buffer.from(value).toString('hex')
			lines.push(`${indent}${field}: <${value.length} bytes> ${hex.length > 80 ? hex.slice(0, 80) + '…' : hex}`)
		}
	}
	return lines.join('\n')
}

async function listen({ auth, pair, out = './captures' }) {
	const { mkdir, writeFile } = await import('node:fs/promises')
	await mkdir(out, { recursive: true })
	let n = 0
	// Baileys drops fields its schema doesn't know, so look at the raw bytes before it decodes them.
	// A message is captured if it mentions field 134, has a sticker, or loses bytes on decode→encode
	// (i.e. contains fields Baileys doesn't know).
	const originalDecode = proto.Message.decode
	proto.Message.decode = function decode(r, l, e) {
		const msg = originalDecode.call(this, r, l, e)
		if (l === undefined && r instanceof Uint8Array) {
			const raw = Buffer.from(r)
			const json = JSON.stringify(msg.toJSON())
			const lossy = originalEncode.call(proto.Message, msg).finish().length < raw.length
			if (lossy || /stickerMessage/.test(json)) {
				const name = `capture-${Date.now()}-${++n}`
				writeFile(path.join(out, `${name}.bin`), raw)
				writeFile(path.join(out, `${name}.txt`), `${dumpRaw(raw)}\n\n--- as Baileys sees it ---\n${JSON.stringify(msg.toJSON(), null, 2)}\n`)
				console.log(`captured ${name} (${raw.length} B${lossy ? ', has fields Baileys does not know' : ''}) -> ${out}/${name}.txt`)
			}
		}
		return msg
	}
	await connect(auth, pair)
	console.log(`listening... send a sound sticker from the official app (to or from this account). Ctrl+C to stop.`)
	await new Promise(() => {})
}

/** Find the AudioMessage inside a captured audio sticker and test our sidecar maths against it. */
async function checkCapture(file) {
	const get = (buf, f) => parseRaw(buf)?.find(x => x.field === f)?.value
	let msg = await readFile(file)
	if (!get(msg, 134) && get(msg, 31)) msg = get(get(msg, 31), 2) // unwrap deviceSentMessage
	const audio = get(get(get(get(msg, 134), 1), 26), 26)
	if (!audio) throw new Error('no audio sticker in this capture')
	const url = Buffer.from(get(audio, 1)).toString()
	const mediaKey = Buffer.from(get(audio, 7))
	const encSha = Buffer.from(get(audio, 8))
	const sidecar = Buffer.from(get(audio, 18))
	const res = await fetch(url)
	if (!res.ok) throw new Error(`download failed: HTTP ${res.status} (media links expire; capture a fresh one)`)
	const enc = Buffer.from(await res.arrayBuffer())
	console.log(`downloaded ${enc.length} B, encSha256 ${createHash('sha256').update(enc).digest().equals(encSha) ? 'OK' : 'MISMATCH'}`)
	console.log(`captured sidecar   ${sidecar.toString('hex')}`)
	for (const withMac of [true, false]) {
		const mine = await computeSidecar(enc, mediaKey, 'audio', withMac)
		console.log(`computed (mac=${withMac ? 'yes' : 'no '}) ${mine.toString('hex')} ${mine.equals(sidecar) ? '<-- MATCH' : ''}`)
	}
}

// ---------- CLI ----------

function parseArgs(argv) {
	const [cmd, visual, audio, ...rest] = argv
	const opts = { cmd, visual, audio, seconds: 10, stanza: 'text', auth: './auth' }
	for (let i = 0; i < rest.length; i += 2) opts[rest[i].replace(/^--/, '')] = rest[i + 1]
	opts.seconds = Math.min(30, Math.max(1, Number(opts.seconds) || 10))
	return opts
}

async function main() {
	if (process.argv[2] === 'check') {
		await checkCapture(process.argv[3])
		process.exit(0)
	}
	if (process.argv[2] === 'listen') {
		const opts = { auth: './auth' }
		const rest = process.argv.slice(3)
		for (let i = 0; i < rest.length; i += 2) opts[rest[i].replace(/^--/, '')] = rest[i + 1]
		return listen(opts)
	}
	const opts = parseArgs(process.argv.slice(2))
	if (!['build', 'send'].includes(opts.cmd) || !opts.visual || !opts.audio || (opts.cmd === 'send' && !opts.to)) {
		console.log(`usage:
  node audio-sticker.mjs build <image|gif|video> <audio> [--seconds 10] [--out ./out]
  node audio-sticker.mjs send  <image|gif|video> <audio> --to <number|jid> [--seconds 10]
                               [--stanza text|media] [--pair <your number>] [--auth ./auth]
                               [--disappear 24h|7d|90d]   (match the chat's disappearing timer)
  node audio-sticker.mjs listen [--out ./captures] [--auth ./auth]   (record real sound stickers)`)
		process.exit(1)
	}
	await stat(opts.visual)
	await stat(opts.audio)
	const workdir = await mkdtemp(path.join(tmpdir(), 'audio-sticker-'))
	try {
		if (opts.cmd === 'build') {
			const { sticker, sound } = await prepareFiles(opts.visual, opts.audio, opts.seconds, workdir)
			const out = opts.out ?? './out'
			await run('mkdir', ['-p', out])
			await run('cp', [sticker.file, path.join(out, 'sticker.webp')])
			await run('cp', [sound.file, path.join(out, 'sound.ogg')])
			console.log(`wrote ${out}/sticker.webp (${sticker.buffer.length} B, animated=${sticker.animated})`)
			console.log(`wrote ${out}/sound.ogg (${sound.buffer.length} B, ${sound.seconds}s)`)
		} else {
			await send(opts, workdir)
		}
	} finally {
		await rm(workdir, { recursive: true, force: true })
	}
	process.exit(0)
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch(err => {
		console.error(err)
		process.exit(1)
	})
}
