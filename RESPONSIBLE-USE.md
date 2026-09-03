**English** | [日本語](RESPONSIBLE-USE.ja.md)

# Responsible use

svgent renders the script you write. It does not collect live sessions or connect to a model, shell, or repository. The script you hand it is all it reads. Authoring a fictional exchange and reworking a real session for an explanation are both intended uses.

## What stays in the output

- Every export carries `simulated=true`. There is no way to remove it.
- What you pick for Script basis is recorded as `model-kind` (`fictional` or `reenactment`).
- No real product's logo or visual identity is reproduced. svgent is an unaffiliated, independent implementation.

## Images and where they are kept

PNG, JPEG, and WebP up to 4 MiB are held as Data URLs inside the open browser tab. There is no upload, account, or server storage. Autosave keeps text and settings only; images live in the tab and in the script JSON you save yourself.
