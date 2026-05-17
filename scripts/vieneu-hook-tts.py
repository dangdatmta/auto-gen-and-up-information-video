#!/usr/bin/env python3
"""Synthesize one Vietnamese news hook with VieNeu-TTS."""

from __future__ import annotations

import argparse
import json
import os
import sys


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a hook voiceover WAV with VieNeu-TTS.")
    parser.add_argument("--text")
    parser.add_argument("--output")
    parser.add_argument("--input-json", help="Batch input: JSON array of {text, output}.")
    parser.add_argument("--mode", default="standard", choices=["standard", "turbo", "remote"])
    parser.add_argument("--emotion", default="natural")
    parser.add_argument("--voice-id", default="")
    parser.add_argument("--api-base", default="")
    parser.add_argument("--model-name", default="")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if bool(args.input_json) == bool(args.text and args.output):
        print("Provide either --input-json or both --text and --output.", file=sys.stderr)
        return 2
    try:
        from vieneu import Vieneu
    except Exception as exc:
        print(
            "VieNeu-TTS SDK is not installed. Install it with `pip install vieneu` "
            "or configure HOOK_TTS_PYTHON to a Python environment that has it.",
            file=sys.stderr,
        )
        print(str(exc), file=sys.stderr)
        return 2

    if args.input_json:
        with open(args.input_json, "r", encoding="utf-8") as file:
            jobs = json.load(file)
        if not isinstance(jobs, list):
            print("--input-json must contain a JSON array.", file=sys.stderr)
            return 2
    else:
        jobs = [{"text": args.text, "output": args.output}]

    init_kwargs = {"emotion": args.emotion}
    if args.mode == "turbo":
        init_kwargs["mode"] = "turbo"
    elif args.mode == "remote":
        init_kwargs["mode"] = "remote"
        if args.api_base:
            init_kwargs["api_base"] = args.api_base
        if args.model_name:
            init_kwargs["model_name"] = args.model_name

    try:
        tts = Vieneu(**init_kwargs)
        voice = tts.get_preset_voice(args.voice_id) if args.voice_id else None
        results = []
        for job in jobs:
            text = str(job.get("text", "")).strip()
            output = str(job.get("output", "")).strip()
            if not text or not output:
                raise ValueError("Each batch item must include non-empty text and output.")
            os.makedirs(os.path.dirname(os.path.abspath(output)), exist_ok=True)
            if voice is None:
                audio = tts.infer(text=text)
            else:
                audio = tts.infer(text=text, voice=voice)
            tts.save(audio, output)
            results.append({"output": output})
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1

    print(json.dumps({
        "outputs": results,
        "mode": args.mode,
        "emotion": args.emotion,
        "voiceId": args.voice_id or None,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
