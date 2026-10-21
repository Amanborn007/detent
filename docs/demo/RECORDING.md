# Recording the in-Claude-Code clip

A 30 to 40 second screen recording of a real run: you ask, Claude works, the gate page opens, you approve, a draft PR appears. Record it on a small throwaway repo with a real, low-risk issue so the PR is genuine. Use a clean terminal (large font, light theme off, no notifications) and a browser window sized to sit beside it.

## The six beats

1. **Type the request (about 5s).** In Claude Code, type something like "start a Detent run for your-org/your-repo#12". Show the prompt being typed, not pasted.
2. **Claude works (about 8s).** Intake, research and plan scroll past. This is the long part in real time, so speed it up. **Label the cut on screen: "sped up 8x" (or whatever factor you used).**
3. **The gate page opens (about 5s).** The browser comes forward with the plan on a local page. Pause on it long enough to read the question and the approve and revise buttons.
4. **Click approve (about 4s).** Scroll the plan once so a viewer sees real content, then click approve. Do not cut here.
5. **Claude builds and checks (about 8s).** Implement, recheck, ship. Speed this up too. **Label it: "sped up 8x" again, and label any cut with "cut: tests running" so nobody thinks the run was instant.**
6. **The draft PR appears (about 5s).** Show the PR page on GitHub marked Draft. End on it. Do not click merge.

Rules for the clip: no cuts inside beats 3 and 4, every speed-up and cut carries an on-screen label, and the PR in beat 6 must be the one the run created.

## Capture with QuickTime

1. Open QuickTime Player, then File, New Screen Recording.
2. Click the options arrow, pick your microphone as None, tick Show Mouse Clicks in Recording.
3. Drag a rectangle around the terminal and browser area. Keep it near 1280x720.
4. Record, then stop from the menu bar. Save as `raw.mov`.

## Make an MP4 under 10 MB

Trim, speed up the labelled stretches, and compress. Replace the timestamps with yours.

```sh
# trim to the part you want
ffmpeg -i raw.mov -ss 0 -to 45 -c copy trimmed.mov

# speed up a stretch 8x: cut it out, speed it, and rejoin (labels go in your editor, or use drawtext below)
ffmpeg -i trimmed.mov -vf "setpts=PTS/8" -an sped.mov

# final encode: 1280 wide, 24 fps, no audio, H.264
ffmpeg -i trimmed.mov -vf "scale=1280:-2,fps=24" -c:v libx264 -crf 28 -preset slow -pix_fmt yuv420p -movflags +faststart -an detent-demo.mp4
ls -lh detent-demo.mp4
```

If it is over 10 MB, raise `-crf` to 30 or scale to 1024 wide. To burn a label into a stretch without an editor:

```sh
ffmpeg -i sped.mov -vf "drawtext=text='sped up 8x':x=24:y=24:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.6" -an sped-labelled.mov
```

## Embed it in the README

GitHub plays an MP4 inline only when it is a user-attachments URL.

1. Open any issue or PR comment box on `Amanborn007/detent` (you do not have to submit it).
2. Drag `detent-demo.mp4` into the box. GitHub uploads it and inserts a line like `https://github.com/user-attachments/assets/<uuid>`.
3. Copy that line into `README.md` where the `DRIVE-CLIP` comment sits, on a line by itself, then delete the comment. Close the comment box without posting.
4. Keep a one-line caption above it saying what is sped up, for example "Sped up where labelled. The PR is real."
