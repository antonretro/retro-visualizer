# Retro Visualizer

**Play it:** https://visualizer.antonretro.com

Music visualizers inspired by the classic Windows Media Player visualizers, rebuilt from scratch for the
web: true widescreen (never stretched), sharp pixel or smooth look, and they react to your own music,
internet radio, MIDI files or a built-in demo beat. Works in any modern browser, on PC, Mac, phones and TVs.

- **Plasma**: warping, blurring 8-bit palette plasma. Random mode plus an original preset collection with
  new effects (wire cubes, gears, lightning, atom orbits, star tunnels, kaleidoscopes).
- **Spectrum**: bars, trails, oscilloscope and dots, drawn pixel by pixel, in several original styles.

### Download for Windows
[**Retro Visualizer for Windows**](https://github.com/antonretro/retro-visualizer/releases/latest): a tiny desktop app
(Windows 10/11, nothing else to install). It finds your Windows files by itself, so the classic presets, the
Windows MIDI sound and the sample songs work without picking anything. Unzip and run `RetroVisualizer.exe`.

### Original songs
Three original songs by Anthony Micallef (jetpack postcard, slap happy forklift, lemonade satellite) are the
default music, as MIDI files in `common/songs/`, under the same MIT licence.

### Bring your own Windows
Nothing from Microsoft is included. If you own Windows 10/11 with Windows Media Player Legacy installed,
you can unlock the original presets: choose **Load classic presets from your Windows** and pick your own
`C:\Windows\System32\wmp.dll`. The presets are read inside your browser and never uploaded. On a Mac or
other system, copy `wmp.dll` from a Windows PC you own. Please don't download DLLs from third-party sites.

The MIDI player can likewise use your own Windows sound bank (`C:\Windows\System32\drivers\gm.dls`), a
SoundFont (`.sf2`) of your choice, or its built-in Retro Synth.

### Run locally
Open `index.html`, or serve this folder with any static web server. Keys: Left/Right preset, Space pause,
F fullscreen, Up/Down volume, X extras.

### Embedding
`embed/` is a small self-contained build for apps (for example an Android TV launcher's WebView): feed it
PCM or spectrum data through a JavaScript API. See `embed/README.md`.

### Credits and licence
Made by Anthony Micallef (antonretro). MIT licence, see `LICENSE`.
The atan2 lookup tables come from AMD LibM (BSD 3-Clause), see `THIRD_PARTY_AMD_LIBM.txt`.

Not affiliated with or endorsed by Microsoft. Windows and Windows Media Player are trademarks of Microsoft
Corporation; other names belong to their owners. See `NOTICE`.
