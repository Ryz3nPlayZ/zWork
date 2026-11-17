#!/bin/zsh
# ./verify.sh deliver/under-the-city.mp4 → probe, loudness, 1-per-second storyboard, frame-difference scan, key stills
set -e
FF=/opt/homebrew/bin/ffmpeg; IN=${1:-deliver/under-the-city.mp4}; D=$(dirname $IN)
/opt/homebrew/bin/ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate,duration,bit_rate -of compact $IN
$FF -hide_banner -i $IN -af ebur128=peak=true -f null - 2>&1 | grep -E '^\s+(I|LRA|Peak):'
rm -rf qa/sb1 && mkdir -p qa/sb1
$FF -v error -i $IN -vf "fps=1,scale=480:-1" -start_number 0 qa/sb1/%03d.png
for f in qa/sb1/*.png; do n=${f:t:r}; mv $f qa/sb1/${n}_$((10#$n)).5.png; done
python3 sheet.py qa/sb1 $D/storyboard.png 6 300
$FF -v error -i $IN -vf "scale=240:135,format=gray" -f rawvideo - | python3 -c "
import sys,numpy as np
f=np.frombuffer(sys.stdin.buffer.read(),np.uint8).reshape(-1,135,240).astype(float)
d=np.abs(np.diff(f,axis=0)).mean((1,2)); z=(d-np.median(d))/(np.median(np.abs(d-np.median(d)))+1e-6)
print('frames',len(f),'| largest frame-to-frame changes:')
for i in sorted(np.argsort(d)[::-1][:8]): print('  %.3fs  diff %.1f'%((i+1)/60,d[i]))
"
for t in 4.5 8 13.5 20 26.9 32.5 40 47 53.2 58.5 62.5 68.6 73 78.8 84 87.5 91.5 97.5; do $FF -v error -y -ss $t -i $IN -frames:v 1 $D/still_${t}s.png; done
