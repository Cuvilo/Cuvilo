# Frequently asked questions

[简体中文](FAQ.md) | **English** · [Home](../README.en.md) · [Getting started](GETTING_STARTED.en.md)

## Do I need my own API keys?

Yes. Cuvilo provides source under GPL-3.0-only, but does not include model or speech credits. Provider pricing, availability and quotas are separate.

## Why does Windows 10 not support process capture?

Cuvilo 0.1.51 incorrectly uses build 20348 as a hard cutoff, rejecting Windows 10 before trying the API. Mature implementations support Windows 10 2004 (build 19041) and later. The source now allows these builds to attempt activation; success still depends on system updates, the target application and the API result. This fix will ship in the next release. In 0.1.51, choose system audio and silence unrelated apps. See the [OBS compatibility guide](https://obsproject.com/kb/application-audio-capture-guide).

## Why is there no transcription?

Play some audio, select the correct output/application source, and run Test audio. Check the speech service credentials, model, activation, quota and network. System audio does not include your microphone automatically; enable My microphone when needed.

## Why does the model test fail?

Use the exact provider endpoint and model identifier. The answer API must support Chat Completions. Check your key, account access and quota. Some models return only reasoning or reject a short test; try a model that returns answer text. Fetch models is optional if the endpoint cannot list models.

## Does local OCR upload the image?

Local Windows OCR recognizes the image on your computer. Subsequent cloud answers still send the needed text to the selected model. Vision and cloud OCR send the selected image to their providers. Install the required OCR language component in Windows language options if local recognition is unavailable.

## Can I use macOS or Linux?

The current native implementation targets Windows x64. There are no native macOS, Linux or Windows ARM64 releases.

## Windows shows an unknown-publisher warning. What should I check?

Confirm the installer came from this repository's release and compare its SHA-256 against the release description. An updater signature is not the same as a Windows publisher code-signing certificate. Do not disable protection for an unknown file or a mismatched checksum.

```powershell
Get-FileHash "Cuvilo_<version>_x64-setup.exe" -Algorithm SHA256
```

## Where are my data and keys?

Materials, settings and text records are under `%APPDATA%/local.interview.copilot/`. Credentials are in Windows Credential Manager under `InterviewCopilot/`. Data backups do not contain service credentials. See the [privacy guide](PRIVACY.en.md).

## Does English interface mode translate my answers?

No. Interface language controls app labels, menus and notifications. It does not rewrite transcripts, questions, materials or model responses, and it does not automatically change the answering prompt's language.

## How do I fully quit?

Use Quit in the tray menu. Closing the main window can minimize to the tray depending on your preference.
