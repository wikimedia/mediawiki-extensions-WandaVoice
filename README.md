# WandaVoice - Voice-Controlled Interface for MediaWiki

WandaVoice is a MediaWiki extension that enables hands-free navigation, editing
and content contribution through natural voice commands. It builds on the
[Wanda extension](https://www.mediawiki.org/wiki/Extension:Wanda) for
LLM-powered intent recognition.

While [WikiSpeech](https://www.mediawiki.org/wiki/Extension:WikiSpeech)
provides text-to-speech for *consuming* wiki content, WandaVoice serves the
complementary purpose of speech-to-text for *creating* and editing content —
addressing the accessibility gap for visually impaired users, users with motor
disabilities, and mobile editors ([T410215](https://phabricator.wikimedia.org/T410215)).

## Features

- **Voice command system**: navigate pages ("Navigate to Main Page", "Open
  history"), execute editing actions ("Edit section 2", "Save changes"), and
  search ("Search for quantum physics") — completely hands-free
- **Intelligent voice dictation**: natural language text input with voice
  controlled formatting ("Make this bold", "Insert heading level 2 History"),
  link creation ("Create link to Albert Einstein") and template insertion
  ("Add citation needed")
- **LLM intent recognition**: compound, multi-step commands ("Navigate to
  Albert Einstein, edit the introduction section, and add a sentence: He was
  born in Germany") are decomposed, validated and executed step by step using
  Wanda's configured LLM
- **Wake phrase**: passive listening for a customizable wake phrase
  ("Wanda", just like "Alexa") with configurable fuzzy-matching sensitivity
- **Accessibility-first design**: spoken confirmations, screen-reader live
  region announcements, high-contrast recording indicators, large touch
  targets, keyboard access (access key `V`), reduced-motion support
- **Privacy-conscious**: WandaVoice itself never records, stores or transmits
  audio — transcription is delegated to the browser's Web Speech API and only
  the final text transcript is processed (note that the browser's speech
  engine may use its vendor's speech service; see Privacy and Security below)
- **Offline fast path**: simple commands (save, undo, cancel, navigation,
  formatting, …) are matched by a local grammar with zero latency and keep
  working even when the LLM is disabled or unreachable

## Requirements

- MediaWiki 1.42.0 or later
- [Wanda extension](https://www.mediawiki.org/wiki/Extension:Wanda) (required
  dependency), configured with an LLM provider
- A browser with Web Speech API support (see Browser Support below)

## Browser Support

WandaVoice ships two interchangeable recognition engines:

- **browser** — the Web Speech API (default where available; no server
  infrastructure needed)
- **server** — MediaRecorder captures silence-delimited utterances and a
  Whisper-compatible speech-to-text service transcribes them server-side
  (same pattern the Phonos extension uses for its pluggable TTS engines)

With `$wgWandaVoiceRecognitionEngine = 'auto'` (default), each browser gets
the best available engine:

| Browser | Voice commands | Engine used | Spoken feedback |
| --- | --- | --- | --- |
| Chrome / Edge / Chromium (desktop and Android) | Yes | browser | Yes |
| Safari 14.1+ (macOS and iOS) | Yes | browser | Yes |
| Firefox | Yes, when a speech-to-text endpoint is configured | server | Yes |
| Brave and some privacy-focused browsers | Yes, when a speech-to-text endpoint is configured | server | Yes |

If neither engine is available (no Web Speech API and no configured STT
endpoint) the microphone button is shown disabled with an explanatory
message, and the rest of the page is unaffected. Recognition language
coverage varies per speech engine.

Note: the server engine has no passive wake-phrase stage — recording only
happens while listening is explicitly on (push-to-talk model), so ambient
audio is never streamed to the server.

## Installation

1. Install and configure the Wanda extension first:

   ```
   cd extensions/
   git clone https://gerrit.wikimedia.org/r/mediawiki/extensions/Wanda
   ```

2. Download WandaVoice into your `extensions/` directory:

   ```
   cd extensions/
   git clone https://gerrit.wikimedia.org/r/mediawiki/extensions/WandaVoice
   ```

3. Add to `LocalSettings.php`:

   ```php
   // Load Wanda first (required dependency)
   wfLoadExtension( 'Wanda' );
   $wgWandaLLMProvider = 'ollama';
   $wgWandaLLMModel = 'gemma:2b';
   // ... other Wanda configuration

   // Load WandaVoice
   wfLoadExtension( 'WandaVoice' );
   ```

4. Navigate to `Special:Version` to verify the installation.

## Configuration

```php
// Enable/disable the extension (default: true)
$wgWandaVoiceEnabled = true;

// Wake phrase configuration
$wgWandaVoiceWakePhrase = 'wanda'; // '' disables wake detection (push-to-talk only)
$wgWandaVoiceWakeSensitivity = 0.7;    // Fuzzy match threshold (0-1)

// Speech recognition settings
$wgWandaVoiceLanguage = '';                          // BCP 47 tag; '' = wiki content language
$wgWandaVoiceFallbackLanguages = [ 'en-GB' ];        // Accent variants
$wgWandaVoiceContinuousMode = true;                  // Keep listening after commands

// LLM integration (uses Wanda's provider configuration)
$wgWandaVoiceUseLLM = true;        // LLM intent parsing for complex commands
$wgWandaVoiceShowThinking = false; // Show command interpretation steps

// Server-side speech recognition (enables Firefox and other browsers
// without the Web Speech API; also a privacy option for Chromium/Safari)
$wgWandaVoiceRecognitionEngine = 'auto'; // 'auto', 'browser' or 'server'
$wgWandaVoiceSTTEndpoint = '';           // e.g. 'https://api.openai.com/v1/audio/transcriptions'
                                         // or a self-hosted 'http://localhost:8000/v1/audio/transcriptions'
$wgWandaVoiceSTTApiKey = '';             // Bearer token; empty for self-hosted servers
$wgWandaVoiceSTTModel = 'whisper-1';     // Model name passed to the endpoint
$wgWandaVoiceSTTTimeout = 30;            // Request timeout in seconds
$wgWandaVoiceMaxAudioSize = 2097152;     // Max audio upload size in bytes

// Accessibility features
$wgWandaVoiceAudioFeedback = true;    // Speak confirmations
$wgWandaVoiceVisualIndicators = true; // Show recording status panel
$wgWandaVoiceHapticFeedback = true;   // Mobile vibration feedback

// Integration settings
$wgWandaVoiceNamespaces = [];        // Namespace IDs; [] = available everywhere
$wgWandaVoiceMobileEnabled = true;   // Enable in the MobileFrontend view

// Command customization
$wgWandaVoiceCustomCommands = [
    'quick save' => 'save changes with summary minor edit'
];
$wgWandaVoiceOfflineCommands = [ 'save', 'preview', 'undo', 'cancel', 'stop listening', 'help' ];
```

## Usage

1. Click the floating microphone button (bottom-left corner) or press the
   access key (usually `Alt`+`Shift`+`V`) to start voice control.
2. Say the wake phrase ("Wanda") followed by a command, or click the
   button again to issue a command directly (push-to-talk).
3. Example commands:

   | Voice command | Result |
   | --- | --- |
   | "Navigate to Main Page" | Opens the page |
   | "Search for quantum physics" | Runs a search |
   | "Edit section 2" | Opens the section editor |
   | "Make this bold" | `'''selected text'''` |
   | "Create heading Ancient Rome" | `== Ancient Rome ==` |
   | "Insert link to Paris" | `[[Paris]]` |
   | "Add citation needed" | `{{citation needed}}` |
   | "Create bullet point First item" | `* First item` |
   | "Start dictation" … "stop dictation" | Inserts spoken sentences as text |
   | "Save changes with summary fixed typo" | Saves with an edit summary |
   | "Undo" | Reverts the last voice edit |

   Compound commands work too: *"Navigate to Albert Einstein, edit the
   introduction section, and add a sentence: He was born in Germany."*

## API

The extension provides `action=wandavoice` (POST), which interprets a
transcribed command into a validated action list:

| Parameter | Required | Description |
| --- | --- | --- |
| `command` | Yes | Transcribed voice command text |
| `context` | No | Current page title for context-aware processing |
| `mode` | No | `command`, `dictation` or `auto` (default) |
| `lang` | No | Voice input language (default: wiki content language) |
| `showthinking` | No | Include interpretation steps (default: false) |

Example response:

```json
{
    "success": true,
    "intent": "navigation_and_edit",
    "voiceProcessed": true,
    "actions": [
        { "type": "navigate", "target": "Albert Einstein", "url": "/wiki/Albert_Einstein", "status": "ready" },
        { "type": "edit_section", "target": "Albert Einstein", "section": 0, "sectionName": "the introduction", "status": "ready" },
        { "type": "insert_text", "wikitext": "He was born in Germany.", "status": "ready" }
    ],
    "audioFeedback": "Navigating to Albert Einstein. Opening the introduction of Albert Einstein for editing. Text inserted."
}
```

Page saves always go through the standard editing interface (or Wanda's
two-phase `wandaedit` module), so every existing permission, protection and
anti-abuse layer keeps applying.

## Privacy and Security

- WandaVoice never stores audio (0 seconds audio retention); transcription is
  performed by the browser's Web Speech API or, with the server engine, by
  the wiki's configured speech-to-text service
- With the browser engine, the speech engine may process audio on the browser
  vendor's servers (e.g. Google for Chrome, Apple for Safari) — this is
  browser behaviour outside the extension's control
- With the server engine, utterances are forwarded to the configured STT
  endpoint and never written to disk or logged; use a self-hosted Whisper
  server (LocalAI, faster-whisper) to keep audio on your own infrastructure
- The STT endpoint and API key stay server-side and are never exposed to
  browsers; audio uploads are size-capped and can be rate limited via the
  `wandavoice-transcribe` key in $wgRateLimits
- Only the final text transcript is sent to the wiki's configured LLM through
  the Wanda extension's existing security layer
- Every LLM-proposed action is validated server-side against a whitelist,
  page titles are resolved safely, and edit permissions are enforced
- For sensitive wikis, use a self-hosted Ollama instance via Wanda

## Limitations

- Editing commands currently target the wikitext editor (including
  CodeMirror); VisualEditor support is planned
- Voice input on Firefox requires configuring a speech-to-text endpoint
  (see Browser Support); wake-phrase listening is browser-engine only
- Recognition quality depends on the speech engine used

## Development

Linting follows the standard MediaWiki toolchain:

```
npm install
npm test           # eslint (Wikimedia preset) + banana i18n checker + stylelint + jest

composer install
composer test      # PHP parallel-lint + MediaWiki-CodeSniffer + MinusX
```

JavaScript unit tests live in `tests/jest/` (run with `npm run test:unit`);
PHPUnit tests live in `tests/phpunit/` and run inside a MediaWiki core
checkout via the standard `composer phpunit` entry points.

## See Also

- [Extension:Wanda](https://www.mediawiki.org/wiki/Extension:Wanda) — required dependency
- [Extension:WandaScore](https://www.mediawiki.org/wiki/Extension:WandaScore) — AI content quality scoring
- [Extension:WandaScribe](https://www.mediawiki.org/wiki/Extension:WandaScribe) — AI writing assistance

## License

GPL-2.0-or-later
