Synthetic VideoToolbox H.264 fixtures: Baseline with no B-frames, Annex B with AUD and SPS/PPS on
keyframes, no screen capture. `mac-high.h264` is `mac.h264` re-encoded as Constrained High, as a
negotiated Mac sends. `noisy.h264` is one random-noise frame whose access unit exceeds 1 MiB while
staying under the protocol's 4 MiB payload bound. The 128×128 key and delta stay above the emulator
hardware AVC decoder's 96×96 minimum; 64×64 selects the software decoder, which buffers still
pictures despite zero reordered frames. The recipe is in the
[mobile skill](../../../../../../../.agents/skills/mobile/SKILL.md).
