#!/bin/sh
# 生成 public-domain sine wave MP3 作为 sim 真实字节占位（无版权，可商用）。
# 真实 royalty-free 曲目（如 Kevin MacLeod CC-BY）授权后替换本 fixture。
# 需 ffmpeg；无 ffmpeg 则 skip（test 跳过）。
set -e
cd "$(dirname "$0")"
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=3" -b:a 128k track1.mp3 2>/dev/null
ffmpeg -y -f lavfi -i "sine=frequency=523:duration=2" -b:a 128k track2.mp3 2>/dev/null
echo "generated track1.mp3 track2.mp3"
