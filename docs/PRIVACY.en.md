# Data and privacy

[简体中文](PRIVACY.md) | **English** · [Home](../README.en.md) · [Getting started](GETTING_STARTED.en.md)

This document describes the desktop client's data flow. It does not replace your selected providers' privacy policies.

## Stored on your computer

- Materials, sessions, text transcripts, answers and settings live under `%APPDATA%/local.interview.copilot/`.
- Service keys are kept in Windows Credential Manager under `InterviewCopilot/`. Cloud requests still send credentials needed to authenticate.
- Raw recordings are not saved by default. Screenshots are temporary and are released after a new capture or the end of the session.
- Knowledge uses local keyword retrieval and snippet limits. No embedding model is downloaded.

## When data leaves your computer

| Action | Data | Recipient |
| --- | --- | --- |
| Cloud speech recognition | Selected audio stream or segments | Your speech provider |
| Model answer | Question, relevant context and material snippets | Your answer-model provider |
| Vision | Selected screenshot and relevant context | Your vision-model provider |
| Cloud OCR | Selected screenshot | Your OCR provider |
| Local Windows OCR | Image recognized locally; required text then sent for a cloud answer | Windows OCR, then your selected model |
| Service test or model listing | Endpoint, credentials and the necessary test request | That service provider |
| Update checks and downloads | Release metadata and installer requests | GitHub and its distribution infrastructure |

Each provider may have its own billing, logging and retention policies. Vision failures may fall back to OCR; whether the image is uploaded depends on your selected OCR service.

## Backups and public feedback

Data backups contain materials and text interview records, but do not include service settings or keys. A backup may still hold personal information. Store it in a trusted location and do not upload it to public issues or repositories.

Use synthetic questions when reporting bugs. Remove keys, account details, resumes and private conversations from logs and screenshots first.

## Deleting and restoring

Delete materials or records in their respective pages. Restoring replaces materials and records after creating a recovery copy; service settings and credentials are kept. To remove local data fully, quit from the tray, confirm your backup, then manage the application data and matching Windows credentials. Uninstalling alone should not be treated as proof that every local record was deleted.

Follow [SECURITY.md](../SECURITY.md) for sensitive vulnerability reports.
