# Setup: switch to a different sending phone

Use this guide to send sound stickers from a different WhatsApp number. The steps are the same the first time you link a phone. Run every command in Terminal on your Mac.

> Use a spare number. Unofficial clients like this one break WhatsApp's Terms of Service, and the number can get banned.

---

## 0. Requirements (first time only)

```bash
brew install node ffmpeg git
git clone https://github.com/Anggel7x/StudyBud.git ~/StudyBud
cd ~/StudyBud && git checkout claude/whatsapp-audio-sticker-rikk5o
```

Skip this if `~/StudyBud` already exists.

## 1. Update the tool

```bash
cd ~/StudyBud/tools/whatsapp-audio-sticker && git checkout -- package-lock.json; git pull && npm install
```

## 2. Unlink the old sending phone

```bash
node audio-sticker.mjs logout
```

This deletes the saved login in `auth/`.

On the **old phone**, open WhatsApp → Settings → **Linked devices**. Tap the old entry (shown as *Chrome* / *Mac OS*), then **Log out**.

## 3. Link the new sending phone

Pick one method.

**A. Pairing code (easier).** Put the new phone's number in international format, without `+`:
```bash
node audio-sticker.mjs groups --pair 32400000000
```
The terminal prints an 8-character code. On the **new phone**, open WhatsApp → Settings → **Linked devices** → **Link a device** → **Link with phone number instead**, then type the code.

**B. QR code:**
```bash
node audio-sticker.mjs groups
```
On the **new phone**, open WhatsApp → Settings → **Linked devices** → **Link a device**, then scan the QR code in the terminal.

When linking finishes, the command lists the groups the new number is in. That confirms the link worked.

## 4. Choose who receives by default

The new number has its own chats and groups. A group like **Bloc** works only if the new number is a member of it.

```bash
node audio-sticker.mjs config --to Bloc --seconds 5          # a group, by name
node audio-sticker.mjs config --to 584124154685 --seconds 5  # or a person
```

For a person whose chat has disappearing messages, add that chat's timer, for example `--disappear 90d`. Groups use their own timer automatically.

## 5. Shortcut (first time only)

```bash
echo "alias sticker='node ~/StudyBud/tools/whatsapp-audio-sticker/audio-sticker.mjs send'" >> ~/.zshrc && source ~/.zshrc
```

## 6. Test

```bash
sticker ~/Downloads/clip.MP4
```

The sticker should arrive with the waveform badge and play its sound when tapped.

---

## Everyday use

| What | Command |
|---|---|
| Video as both picture and sound | `sticker <video>` |
| Separate picture and sound | `sticker <picture> <sound>` |
| Another receiver, once | `sticker <file> --to 34600111222` or `--to "Group name"` |
| Change the default receiver | `node ~/StudyBud/tools/whatsapp-audio-sticker/audio-sticker.mjs config --to <number or group>` |
| Different length, once (max 10 s for WhatsApp) | `sticker <file> --seconds 8` |
| See your groups | `node ~/StudyBud/tools/whatsapp-audio-sticker/audio-sticker.mjs groups` |

Tip: type `sticker `, drag the file from Finder into Terminal, then press Enter.

## Troubleshooting

- **"No groups match"**: the new number isn't in that group, or the name is different. Copy the exact name from the list it prints, and put it in quotes.
- **No pairing code or QR code, or "connection closed"**: run `node audio-sticker.mjs logout` and repeat step 3.
- **The sticker arrives without sound**: the receiving phone may not have sound stickers yet. If it does, add `--stanza media` and try again.
- **The sticker doesn't disappear in a chat with disappearing messages**: pass that chat's timer, `--disappear 24h`, `7d` or `90d`.
