Synthetic VideoToolbox Baseline fixtures, no B frames, 2.5 Mbps target, GOP 60,
Annex B with AUD and SPS/PPS on keyframes. No screen capture. `mac.h264` is
1512×982 (two frames); `resized.h264` is 1280×800 (two frames).
`noisy.h264` is one 1920×1248 random-noise frame. Its encoded access unit is
larger than 1 MiB despite the average bitrate target; it remains below the
protocol's 4 MiB payload bound.

Generate two concatenated lavfi colour sources (lime then blue) at 1512x982
(or 1280x800), rate 2, duration 0.5 each,
`-frames:v 2 -c:v h264_videotoolbox -profile:v baseline -bf 0 -g 60
-b:v 2500k -bsf:v h264_metadata=aud=insert -f h264`.
For noise use `nullsrc=size=1920x1248:rate=30,geq=lum=random(1)*255:cb=random(2)*255:cr=random(3)*255`
and `-frames:v 1` with the same encoder options.
