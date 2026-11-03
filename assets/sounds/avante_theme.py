"""아반떼 테마곡 합성.

구성 (112 BPM, 4/4)
- 인트로 1마디: 깜빡이 '딸깍' 소리
- A (평소, 8마디, C장조): 무난하고 다정한 사무실 팝. 부드러운 사각파 멜로디
- 전환 1마디: 엔진 회전 상승음 + 배기 '팡팡'
- B (N 모드, 8마디, A단조): 빠른 8분음표 베이스, 16분 하이햇, 톱니파 리드
- 아웃트로: C 화음 한 방
출력: 전체곡, A만 반복용, B만 반복용 (모노 44.1kHz 16bit WAV)
"""
import sys
import wave
from pathlib import Path

import numpy as np

SR = 44100
BPM = 112
BEAT = 60 / BPM
BAR = BEAT * 4
rng = np.random.default_rng(7)

NOTE = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5, "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}


def hz(name):
    n, octave = name[:-1], int(name[-1])
    return 440.0 * 2 ** ((NOTE[n] + 12 * (octave + 1) - 69) / 12)


def env(n, a=0.01, d=0.08, s=0.7, r=0.08):
    t = np.arange(n) / SR
    dur = n / SR
    e = np.ones(n) * s
    e[t < a] = t[t < a] / a
    m = (t >= a) & (t < a + d)
    e[m] = 1 - (1 - s) * (t[m] - a) / d
    rel = t > dur - r
    e[rel] *= np.clip((dur - t[rel]) / r, 0, 1)
    return e


def osc(kind, f, n, vib=0.0):
    t = np.arange(n) / SR
    ph = 2 * np.pi * f * t
    if vib:
        ph += vib * np.sin(2 * np.pi * 5.5 * t) * np.clip(t / 0.25, 0, 1)
    if kind == "sine":
        return np.sin(ph)
    if kind == "tri":
        return 2 / np.pi * np.arcsin(np.sin(ph))
    if kind == "square":  # 부드럽게: 홀수 배음 몇 개만
        return sum(np.sin(k * ph) / k for k in (1, 3, 5, 7)) * 0.9
    if kind == "saw":
        return sum(np.sin(k * ph) / k for k in range(1, 12)) * 0.6
    raise ValueError(kind)


def lowpass(x, cut):
    a = np.exp(-2 * np.pi * cut / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i, v in enumerate(x):
        acc = (1 - a) * v + a * acc
        y[i] = acc
    return y


class Track:
    def __init__(self, seconds):
        self.buf = np.zeros(int(seconds * SR) + SR)

    def add(self, start, sig, gain=1.0):
        i = int(start * SR)
        self.buf[i:i + len(sig)] += sig * gain


def melody(tr, start, notes, kind, gain, vib=0.0, legato=0.92):
    t = start
    for name, beats in notes:
        dur = beats * BEAT
        if name != "-":
            n = int(dur * legato * SR)
            tr.add(t, osc(kind, hz(name), n, vib) * env(n, a=0.01, d=0.1, s=0.75, r=0.06), gain)
        t += dur


def chords(tr, start, prog, gain):
    for i, notes in enumerate(prog):
        n = int(BAR * SR)
        sig = sum(osc("tri", hz(x), n) for x in notes) / len(notes)
        tr.add(start + i * BAR, sig * env(n, a=0.12, d=0.3, s=0.6, r=0.25), gain)


def kick(tr, t, gain=0.9):
    n = int(0.18 * SR)
    tt = np.arange(n) / SR
    f = 45 + 80 * np.exp(-tt * 30)
    tr.add(t, np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt * 18), gain)


def snare(tr, t, gain=0.35):
    n = int(0.14 * SR)
    tt = np.arange(n) / SR
    s = rng.standard_normal(n) * np.exp(-tt * 28) + 0.5 * np.sin(2 * np.pi * 190 * tt) * np.exp(-tt * 35)
    tr.add(t, s, gain)


def hat(tr, t, gain=0.08):
    n = int(0.04 * SR)
    x = rng.standard_normal(n)
    x = x - lowpass(x, 6000)
    tr.add(t, x * np.exp(-np.arange(n) / SR * 90), gain)


def tick(tr, t, gain=0.25):  # 깜빡이 '딸깍'
    n = int(0.03 * SR)
    tt = np.arange(n) / SR
    tr.add(t, np.sin(2 * np.pi * 2400 * tt) * np.exp(-tt * 200), gain)


def pop(tr, t, gain=0.6):  # 배기 '팡'
    n = int(0.12 * SR)
    tt = np.arange(n) / SR
    x = lowpass(rng.standard_normal(n), 900) * 3 + np.sin(2 * np.pi * 70 * tt)
    tr.add(t, x * np.exp(-tt * 40), gain)


def rev(tr, t, dur, gain=0.35):  # 엔진 회전 상승
    n = int(dur * SR)
    tt = np.arange(n) / SR
    f = 55 * 2 ** (2.2 * (tt / dur) ** 1.6)
    ph = 2 * np.pi * np.cumsum(f) / SR
    x = sum(np.sin(k * ph) / k for k in range(1, 8)) * (0.6 + 0.4 * np.sin(2 * np.pi * 28 * tt))
    tr.add(t, x * (tt / dur) ** 1.2, gain)


# ---------------- 악보 ----------------
A_PROG = [["C4", "E4", "G4"], ["A3", "C4", "E4"], ["F3", "A3", "C4"], ["G3", "B3", "D4"]] * 2
A_BASS = ["C3", "A2", "F2", "G2"] * 2
A_MEL = [
    ("E4", 1), ("G4", 1), ("C5", 1.5), ("B4", .5),
    ("A4", 1), ("G4", 1), ("E4", 2),
    ("F4", 1), ("A4", 1), ("C5", 1), ("A4", 1),
    ("G4", 1.5), ("F4", .5), ("E4", 1), ("D4", 1),
    ("E4", 1), ("G4", 1), ("C5", 1), ("E5", 1),
    ("D5", 1), ("C5", 1), ("A4", 2),
    ("F4", .5), ("G4", .5), ("A4", 1), ("C5", 1), ("D5", 1),
    ("B4", 2), ("G4", 2),
]

B_PROG = [["A3", "C4", "E4"], ["F3", "A3", "C4"], ["C4", "E4", "G4"], ["G3", "B3", "D4"],
          ["A3", "C4", "E4"], ["F3", "A3", "C4"], ["G3", "B3", "D4"], ["G3", "B3", "D4"]]
B_BASS = ["A2", "F2", "C3", "G2", "A2", "F2", "G2", "G2"]
B_MEL = [
    ("A5", .5), ("A5", .5), ("G5", .5), ("A5", .5), ("C6", 1), ("A5", 1),
    ("F5", .5), ("G5", .5), ("A5", 1), ("G5", .5), ("F5", .5), ("E5", 1),
    ("E5", .5), ("G5", .5), ("C6", 1), ("B5", .5), ("C6", .5), ("D6", 1),
    ("D6", 1.5), ("B5", .5), ("G5", 2),
    ("A5", .5), ("B5", .5), ("C6", .5), ("E6", .5), ("D6", 1), ("C6", 1),
    ("A5", .5), ("C6", .5), ("F6", 1), ("E6", 1), ("C6", 1),
    ("D6", .5), ("D6", .5), ("B5", .5), ("G5", .5), ("B5", 1), ("D6", 1),
    ("E6", .5), ("D6", .5), ("B5", 1), ("G5", 2),
]


def section_a(tr, t0):
    chords(tr, t0, A_PROG, 0.16)
    for i, b in enumerate(A_BASS):
        for h in (0, 2):
            n = int(BEAT * 1.9 * SR)
            tr.add(t0 + i * BAR + h * BEAT, osc("tri", hz(b), n) * env(n, s=0.8), 0.35)
    melody(tr, t0, A_MEL, "square", 0.22, vib=0.15)
    for bar in range(8):
        bt = t0 + bar * BAR
        kick(tr, bt, 0.7); kick(tr, bt + 2.5 * BEAT, 0.5)
        snare(tr, bt + BEAT, 0.25); snare(tr, bt + 3 * BEAT, 0.25)
        for k in range(8):
            hat(tr, bt + k * BEAT / 2, 0.05)
        tick(tr, bt + 3.5 * BEAT, 0.08)  # 마디 끝마다 작은 깜빡이 소리


def section_b(tr, t0):
    chords(tr, t0, B_PROG, 0.14)
    for i, b in enumerate(B_BASS):
        for k in range(8):
            n = int(BEAT / 2 * 0.85 * SR)
            note = b if k % 2 == 0 else b[:-1] + str(int(b[-1]) + 1)
            sig = lowpass(osc("saw", hz(note), n), 1400) * env(n, a=0.005, d=0.05, s=0.6, r=0.03)
            tr.add(t0 + i * BAR + k * BEAT / 2, sig, 0.4)
    lead = Track(8 * BAR)
    melody(lead, 0, B_MEL, "saw", 0.2, vib=0.25, legato=0.85)
    tr.add(t0, lowpass(lead.buf, 3800))
    melody(tr, t0, [(n[:-1] + str(int(n[-1]) - 1), b) for n, b in B_MEL], "square", 0.07)  # 한 옥타브 아래 겹침
    for bar in range(8):
        bt = t0 + bar * BAR
        for k in range(4):
            kick(tr, bt + k * BEAT, 0.8)
        snare(tr, bt + BEAT, 0.4); snare(tr, bt + 3 * BEAT, 0.4)
        for k in range(16):
            hat(tr, bt + k * BEAT / 4, 0.07 if k % 2 else 0.1)
        if bar in (3, 7):
            pop(tr, bt + 3.5 * BEAT, 0.35)


def finish(buf, trim=True):
    buf = buf / (np.max(np.abs(buf)) + 1e-9) * 1.4
    buf = np.tanh(buf) * 0.9
    if not trim:  # 반복용은 길이를 정확히 유지
        return buf
    end = np.max(np.nonzero(np.abs(buf) > 1e-4)) + int(0.05 * SR)
    return buf[:end]


def save(path, buf):
    data = (np.clip(buf, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(data.tobytes())
    print(f"{path.name}: {len(buf) / SR:.1f}s")


def loop_cut(buf, bars):
    """반복용: 정확히 n마디 길이로 자르고, 넘친 꼬리는 앞부분에 겹쳐 이음매를 없앤다."""
    n = int(bars * BAR * SR)
    out = buf[:n].copy()
    tail = buf[n:]
    out[:len(tail)] += tail[:n]
    return out


def main():
    out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)

    full = Track(20 * BAR)
    for k in range(4):
        tick(full, k * BEAT, 0.3)
    section_a(full, BAR)
    rev(full, 9 * BAR, BAR)
    pop(full, 9 * BAR + 3 * BEAT); pop(full, 9 * BAR + 3.5 * BEAT)
    section_b(full, 10 * BAR)
    end = 18 * BAR
    chords(full, end, [["C4", "E4", "G4", "C5"]], 0.35)
    kick(full, end, 1.0); pop(full, end + 0.05, 0.4)
    melody(full, end, [("C6", 2)], "saw", 0.2)
    save(out / "avante_theme.wav", finish(full.buf))

    a = Track(9 * BAR); section_a(a, 0)
    save(out / "avante_normal_loop.wav", finish(loop_cut(a.buf, 8), trim=False))
    b = Track(9 * BAR); section_b(b, 0)
    save(out / "avante_n_mode_loop.wav", finish(loop_cut(b.buf, 8), trim=False))


if __name__ == "__main__":
    main()
