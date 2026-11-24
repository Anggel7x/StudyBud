# WhatsApp sticker with sound

`audio-sticker.mjs` sends a WhatsApp **audio sticker**: a WebP sticker that plays up to about 10 seconds of sound. It uses [Baileys](https://github.com/WhiskeySockets/Baileys).

> ⚠️ This uses an unofficial client, which is against WhatsApp's Terms of Service. Use a spare number, not your main number or anything used for clients. The recipient's WhatsApp must already have the audio-sticker feature, which is still rolling out. Without it, they see nothing or a plain sticker.

## Requirements
- Node 20 or newer
- `ffmpeg` and `ffprobe` on your PATH

```bash
cd tools/whatsapp-audio-sticker
npm install
```

## Quick use
Save your defaults once:
```bash
node audio-sticker.mjs config --to 34600111222 --seconds 5 --disappear 90d
```
Then, from anywhere:
```bash
node audio-sticker.mjs send clip.mp4                # one video = picture + sound
node audio-sticker.mjs send cat.gif meow.mp3        # separate picture and sound
node audio-sticker.mjs send clip.mp4 --seconds 8    # override any default once
```
- On the first send, link the phone. Scan the QR code, or add `--pair <your number>` to get a code instead.
- The picture can be an image, a GIF or a video.
- The sound can be any audio or video file. Only its first `--seconds` are used.
- WhatsApp's limit for the sound is 10 s. The script accepts up to 30 s.
- If the sticker doesn't arrive or plays no sound, add `--stanza media`.
- Run `node audio-sticker.mjs` with no arguments to see every option.

## How it works
Baileys' protobuf schema doesn't know these fields yet, so the script encodes two layers by hand:

```
Message
 ├─ messageContextInfo.messageSecret = 32 random bytes
 └─ [134] audioStickerMessage : FutureProofMessage
       └─ [1] message : Message
             └─ [26] stickerMessage : StickerMessage   (uploaded WebP)
                   └─ [26] audioMessage : AudioMessage (uploaded Ogg/Opus, sidecar)
```
- Both media files are uploaded with Baileys' normal `prepareWAMessageMedia`.
- The audio carries no `ptt` flag or waveform. It has a `streamingSidecar` and `contextInfo` field 74, both checked against a real sticker the iOS app sent.
- `proto.Message.encode` is wrapped so it adds field 134 to the outgoing message.
- Baileys is pinned to `7.0.0-rc14` because the script patches its encoder.
- The audio is Opus in Ogg, made with `-vbr on -compression_level 10 -frame_duration 20 -avoid_negative_ts make_zero`. Without those flags, phones show the sticker but won't play the sound.

The field numbers come from community reverse engineering: zapota PR #10 and whatsapp-rust PR #2110. They are not official.
