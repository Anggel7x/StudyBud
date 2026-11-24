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

## 1. Build the files locally (no WhatsApp needed)
```bash
node audio-sticker.mjs build cat.png meow.mp3 --out ./out
```
This writes `out/sticker.webp` and `out/sound.ogg`, so you can check both before sending.

## 2. Send
```bash
# First run: scan the QR with the spare phone (WhatsApp > Linked devices)
node audio-sticker.mjs send cat.png meow.mp3 --to 34600111222

# Or link with a pairing code instead of a QR
node audio-sticker.mjs send cat.png meow.mp3 --to 34600111222 --pair 34600999888
```
- `--to`: a phone number in international format with no `+`, or a full JID such as `1234@g.us` for a group.
- The visual can be an image (static sticker), or a GIF or video (animated sticker, cut to fit under 1 MB).
- `--seconds N`: how much of the audio to keep. The default is 10.
- The login is saved in `./auth`, so later runs don't ask you to scan again.

### If the sticker doesn't arrive or is silent
The community hasn't settled how the outer message is labelled, so try the other option:
```bash
node audio-sticker.mjs send cat.png meow.mp3 --to 34600111222 --stanza media
```
- `--stanza text` (the default) matches zapota, which has been tested on phones.
- `--stanza media` sends `type="media"` with `mediatype="sticker"`, which is how whatsapp-rust does it.

## How it works
Baileys' protobuf schema doesn't know these fields yet, so the script encodes two layers by hand:

```
Message
 ├─ messageContextInfo.messageSecret = 32 random bytes
 └─ [134] audioStickerMessage : FutureProofMessage
       └─ [1] message : Message
             └─ [26] stickerMessage : StickerMessage   (uploaded WebP)
                   └─ [26] audioMessage : AudioMessage (uploaded Ogg/Opus, ptt=true, waveform)
```
- Both media files are uploaded with Baileys' normal `prepareWAMessageMedia`.
- `proto.Message.encode` is wrapped so it adds field 134 to the outgoing message.
- Baileys is pinned to `7.0.0-rc14` because the script patches its encoder.
- The audio is Opus in Ogg, made with `-vbr on -compression_level 10 -frame_duration 20 -avoid_negative_ts make_zero`. Without those flags, phones show the sticker but won't play the sound.

The field numbers come from community reverse engineering: zapota PR #10 and whatsapp-rust PR #2110. They are not official.
