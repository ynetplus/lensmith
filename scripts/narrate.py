"""Lensmith narration helper: synthesize narration lines and report word timings.

Run by `lensmith narrate` (src/commands/narrate.ts), never by hand:

    uv run --no-project --with kokoro --with soundfile scripts/narrate.py <job.json> <result.json>
    uv run --no-project --with edge-tts scripts/narrate.py <job.json> <result.json>

The job file is written by narrate.ts:
    {"engine": "kokoro"|"edge", "voice": "<id>", "lines": [{"id", "text", "file"}]}
`text` is already clean (no [[mark]] tags) and `file` is the absolute audio path to write.
The result file maps each line id to {"durationMs", "speechStartMs", "speechEndMs",
"words": [{"text", "startMs", "endMs"}]}. speechStartMs / speechEndMs are the first and last
moment the clip is louder than -40 dBFS: the voice inside the file's own leading and trailing
silence. The audio file itself is never trimmed, so word times stay relative to the file.
Mark times, caption cues and the cache are computed in narrate.ts from these words.

A job with "measure": true and lines [{"id", "file"}] synthesizes nothing: it only measures
the speech bounds of existing clips (cache entries written before the bounds existed).
`narrate.py --bounds <clip>` prints one clip's bounds as JSON (WAV needs only Python's
standard library; other formats are decoded with ffmpeg).

Engines:
- kokoro (default): local, Apache-2.0 (github.com/hexgrad/kokoro). Writes 24 kHz WAV. Word
  times come from Kokoro's own per-token timestamps (`start_ts` / `end_ts`), which the
  English pipeline fills from the model's predicted durations. The model weights download
  once from Hugging Face on first use.
- edge: Edge TTS, an unofficial client for Microsoft's online Read Aloud service, which the
  user opts into. Writes MP3; word times come from its WordBoundary events. Needs network
  access and ffprobe (from ffmpeg) for the clip duration.

Exit codes: 0 ok, 2 bad job / synthesis failure, 3 a required Python package is missing.

Adapted from Papermorph's scripts/tts.py (https://github.com/DozenTwelve/Papermorph):
the Edge TTS WordBoundary synthesis loop and the ffprobe duration call. Papermorph is
licensed under the MIT License, reproduced in full below.

    MIT License

    Copyright (c) 2026 TedKaczynski

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

KOKORO_RATE = 24000
MISSING_PACKAGE_EXIT = 3
SPEECH_DBFS = -40.0
SPEECH_LEVEL = 10 ** (SPEECH_DBFS / 20)  # linear amplitude of -40 dBFS, full scale = 1.0
DECODE_RATE = 24000


def missing(package, err):
    print(f"lensmith-narrate: missing package: {package} ({err})", file=sys.stderr)
    sys.exit(MISSING_PACKAGE_EXIT)


def is_word(text):
    return any(c.isalnum() for c in text)


def ms(seconds):
    return int(round(seconds * 1000))


def speech_bounds(samples, rate):
    """First and last sample above -40 dBFS, in ms: (speechStartMs, speechEndMs).

    `samples` is mono, full scale = 1.0 (a numpy array or any sequence of floats). A clip with
    no sample above the level (silence) reports the whole clip.
    """
    n = len(samples)
    duration = ms(n / rate)
    first = next((i for i in range(n) if abs(samples[i]) > SPEECH_LEVEL), None)
    if first is None:
        return 0, max(duration, 1)
    last = next(i for i in range(n - 1, -1, -1) if abs(samples[i]) > SPEECH_LEVEL)
    start = min(ms(first / rate), duration - 1)
    end = max(start + 1, min(ms((last + 1) / rate), duration))
    return start, end


def read_samples(path):
    """Decode a clip to mono floats (full scale 1.0) and its sample rate.

    16-bit PCM WAV (what Kokoro writes) is read with the standard library; anything else
    (Edge's MP3) is decoded by ffmpeg to 16-bit mono PCM.
    """
    import array

    path = Path(path)
    if path.suffix.lower() == ".wav":
        import wave

        with wave.open(str(path), "rb") as w:
            if w.getsampwidth() == 2:
                channels, rate = w.getnchannels(), w.getframerate()
                pcm = array.array("h", w.readframes(w.getnframes()))
                if sys.byteorder == "big":
                    pcm.byteswap()
                return [v / 32768.0 for v in pcm[::channels]], rate
    r = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-f", "s16le", "-acodec", "pcm_s16le",
         "-ac", "1", "-ar", str(DECODE_RATE), "-"],
        capture_output=True, check=True)
    pcm = array.array("h", r.stdout)
    if sys.byteorder == "big":
        pcm.byteswap()
    return [v / 32768.0 for v in pcm], DECODE_RATE


def file_bounds(path):
    samples, rate = read_samples(path)
    return speech_bounds(samples, rate)


def bounds_fields(start, end):
    return {"speechStartMs": start, "speechEndMs": end}


def measure(lines):
    out = {}
    for line in lines:
        out[line["id"]] = bounds_fields(*file_bounds(line["file"]))
        print(f"lensmith-narrate: {line['id']}: speech bounds measured", file=sys.stderr)
    return out


def synth_kokoro(lines, voice):
    try:
        import numpy as np
        import soundfile as sf
        from kokoro import KPipeline
    except ImportError as err:
        missing("kokoro", err)
    # Kokoro voice ids start with the language code: a = American English, b = British English.
    lang = voice[0] if voice[:1] in ("a", "b") else "a"
    pipeline = KPipeline(lang_code=lang, repo_id="hexgrad/Kokoro-82M")
    out = {}
    for line in lines:
        chunks, words, offset = [], [], 0.0
        for result in pipeline(line["text"], voice=voice, split_pattern=None):
            if result.audio is None:
                continue
            audio = result.audio.numpy()
            for tok in result.tokens or []:
                if tok.start_ts is None or tok.end_ts is None or not is_word(tok.text):
                    continue
                words.append({"text": tok.text, "startMs": ms(offset + tok.start_ts),
                              "endMs": ms(offset + tok.end_ts)})
            chunks.append(audio)
            offset += len(audio) / KOKORO_RATE
        if not chunks:
            raise RuntimeError(f"Kokoro produced no audio for line {line['id']!r}")
        audio = np.concatenate(chunks)
        write_audio(line["file"], lambda p: sf.write(p, audio, KOKORO_RATE, format="WAV"))
        out[line["id"]] = {"durationMs": ms(len(audio) / KOKORO_RATE),
                           **bounds_fields(*speech_bounds(audio, KOKORO_RATE)), "words": words}
        print(f"lensmith-narrate: {line['id']}: synthesized (kokoro)", file=sys.stderr)
    return out


def synth_edge(lines, voice):
    try:
        import asyncio

        import edge_tts
    except ImportError as err:
        missing("edge-tts", err)

    async def one(text, path):
        words = []
        comm = edge_tts.Communicate(text, voice, boundary="WordBoundary")
        with open(path, "wb") as f:
            async for chunk in comm.stream():
                if chunk["type"] == "audio":
                    f.write(chunk["data"])
                elif chunk["type"] == "WordBoundary":
                    start = chunk["offset"] / 1e7
                    words.append({"text": chunk["text"], "startMs": ms(start),
                                  "endMs": ms(start + chunk["duration"] / 1e7)})
        return words

    out = {}
    for line in lines:
        holder = {}

        def write(path, line=line, holder=holder):
            holder["words"] = asyncio.run(one(line["text"], path))
            holder["durationMs"] = ms(duration(path))
            holder["bounds"] = file_bounds(path)

        write_audio(line["file"], write)
        start, end = holder["bounds"]
        end = min(end, holder["durationMs"])  # decoded length can differ from ffprobe's by a frame
        out[line["id"]] = {"durationMs": holder["durationMs"],
                           **bounds_fields(min(start, end - 1), end),
                           "words": [w for w in holder["words"] if is_word(w["text"])]}
        print(f"lensmith-narrate: {line['id']}: synthesized (edge)", file=sys.stderr)
    return out


def duration(path):
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True)
    return float(r.stdout)


def write_audio(final, writer):
    """Write to a temp file beside `final`, then rename, so a failure never leaves half a clip."""
    final = Path(final)
    final.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=final.parent, prefix=f".{final.stem}-", suffix=final.suffix)
    os.close(fd)
    try:
        writer(tmp)
        umask = os.umask(0)
        os.umask(umask)
        os.chmod(tmp, 0o666 & ~umask)  # mkstemp creates 0600; give the clip normal permissions
        Path(tmp).replace(final)
    finally:
        Path(tmp).unlink(missing_ok=True)


def main(job_path, result_path):
    job = json.loads(Path(job_path).read_text(encoding="utf-8"))
    if job.get("measure"):
        out = measure(job["lines"])
        Path(result_path).write_text(json.dumps({"lines": out}), encoding="utf-8")
        return
    engine, voice, lines = job["engine"], job["voice"], job["lines"]
    if engine == "kokoro":
        out = synth_kokoro(lines, voice)
    elif engine == "edge":
        out = synth_edge(lines, voice)
    else:
        raise SystemExit(f"unknown engine {engine!r}")
    Path(result_path).write_text(json.dumps({"lines": out}), encoding="utf-8")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--bounds":
        print(json.dumps(bounds_fields(*file_bounds(sys.argv[2]))))
        sys.exit(0)
    if len(sys.argv) != 3:
        print("usage: narrate.py <job.json> <result.json> | --bounds <clip>", file=sys.stderr)
        sys.exit(2)
    try:
        main(sys.argv[1], sys.argv[2])
    except SystemExit:
        raise
    except Exception as err:  # surface one readable line to narrate.ts
        print(f"lensmith-narrate: error: {err}", file=sys.stderr)
        sys.exit(2)
