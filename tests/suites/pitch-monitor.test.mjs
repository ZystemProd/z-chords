// The Voice → Pitch tab, driven end to end with a fake microphone.
//
// getUserMedia is replaced by an oscillator routed into a MediaStream, so the
// test decides exactly what the "singer" sings and can change it mid-take.
// A sawtooth rather than a sine: its overtones are as loud as a sung vowel's,
// which is where an octave error would show.
//
// What is asserted is painted, not internal: the trace's pixels sit on the
// row of the note being sung (found through the geometry the canvas
// publishes, not by re-deriving the layout), the readout names that note,
// replay shows the take rather than the live microphone, and the microphone
// track is really ended on Stop and on leaving the tab.
import { openApp } from "../lib/browser.mjs";

export const name = "Pitch monitor";

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

async function fakeMicrophone(page, freq, level = 0.3, vibratoCents = 0) {
  await page.evaluate((f, lv, vib) => {
    const fake = { freq: f, tracks: [] };
    window.__fakeMic = fake;
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext();
      await ctx.resume();
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = fake.freq;
      if (vib) {
        // ~5.5 Hz vibrato, as a singer's: depth in Hz at this pitch.
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 5.5;
        const depth = ctx.createGain();
        depth.gain.value = fake.freq * (2 ** (vib / 1200) - 1);
        lfo.connect(depth).connect(osc.frequency);
        lfo.start();
      }
      const gain = ctx.createGain();
      gain.gain.value = lv;
      const dest = ctx.createMediaStreamDestination();
      osc.connect(gain).connect(dest);
      osc.start();
      fake.setFreq = (hz) => osc.frequency.setValueAtTime(hz, ctx.currentTime);
      fake.tracks.push(...dest.stream.getTracks());
      return dest.stream;
    };
  }, freq, level, vibratoCents);
}

const noteText = (page) =>
  page.$eval("#pitchNote", (n) => n.textContent.replace(/\s/g, ""));

async function waitForNote(page, text, timeout = 6000) {
  try {
    await page.waitForFunction(
      (t) => document.querySelector("#pitchNote").textContent.replace(/\s/g, "") === t,
      { timeout },
      text
    );
    return true;
  } catch (_) {
    return false;
  }
}

const state = (page) => page.$eval("#pitchPanel", (p) => p.dataset.state);

// Line-coloured pixels in a band around the lane of `midi`, over the newest
// `spanPx` of the graph. `kind` is "in" (the in-tune colour), "off" (the
// out-of-tune colour) or "any". The colours come from the panel's tokens, so
// the test follows a palette change instead of pinning hex values.
async function tracePixelsAt(page, midi, spanPx = 120, kind = "any") {
  return page.evaluate(
    (m, span, kind) => {
      const c = document.getElementById("pitchCanvas");
      const d = c.dataset;
      const dpr = c.width / c.clientWidth;
      const lo = +d.lo, hi = +d.hi, top = +d.graphTop, bottom = +d.graphBottom, right = +d.graphRight;
      const y = bottom - ((m - lo) / (hi - lo)) * (bottom - top);
      const cs = getComputedStyle(document.getElementById("pitchPanel"));
      const rgb = (name) => {
        const hex = cs.getPropertyValue(name).trim().replace("#", "");
        return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
      };
      const targets = kind === "in" ? [rgb("--pitch-in-tune")]
        : kind === "off" ? [rgb("--pitch-off-tune")]
        : [rgb("--pitch-in-tune"), rgb("--pitch-off-tune")];
      const img = c.getContext("2d").getImageData(
        Math.round((right - span) * dpr), Math.round((y - 4) * dpr),
        Math.round(span * dpr), Math.round(8 * dpr)
      );
      let n = 0;
      for (let i = 0; i < img.data.length; i += 4) {
        const px = [img.data[i], img.data[i + 1], img.data[i + 2]];
        if (targets.some((t) => Math.hypot(px[0] - t[0], px[1] - t[1], px[2] - t[2]) < 40)) n++;
      }
      return n;
    },
    midi,
    spanPx,
    kind
  );
}

// The colour painted on the keyboard key of `midi`, as [r, g, b].
async function keyColour(page, midi) {
  return page.evaluate((m) => {
    const c = document.getElementById("pitchCanvas");
    const d = c.dataset;
    const dpr = c.width / c.clientWidth;
    const lo = +d.lo, hi = +d.hi, top = +d.graphTop, bottom = +d.graphBottom;
    const y = bottom - ((m - lo) / (hi - lo)) * (bottom - top);
    // x = 20: inside the black keys too, which are the narrower ones.
    const px = c.getContext("2d").getImageData(Math.round(20 * dpr), Math.round(y * dpr), 1, 1).data;
    return [px[0], px[1], px[2]];
  }, midi);
}

const tokenRGB = (page, name) =>
  page.evaluate((n) => {
    const hex = getComputedStyle(document.getElementById("pitchPanel")).getPropertyValue(n).trim().replace("#", "");
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  }, name);

const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 40;

// WCAG contrast of both line colours against the display background.
async function lineContrast(page) {
  return page.evaluate(() => {
    const cs = getComputedStyle(document.getElementById("pitchPanel"));
    const rgb = (name) => {
      const hex = cs.getPropertyValue(name).trim().replace("#", "");
      return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    };
    const lum = ([r, g, b]) => {
      const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (x, y) => {
      const [a, b] = [lum(x), lum(y)].sort((p, q) => q - p);
      return (a + 0.05) / (b + 0.05);
    };
    const bg = rgb("--pitch-bg");
    const inT = rgb("--pitch-in-tune");
    const off = rgb("--pitch-off-tune");
    return { inTune: ratio(inT, bg), offTune: ratio(off, bg), between: ratio(inT, off) };
  });
}

export default async function run({ browser, origin, t }) {
  const page = await openApp(browser, origin, {
    state: {
      "cv-instrument": "voice",
      // A fixed range, so the rows of A4 and C5 are known and stay put.
      "cv-pitch-settings": { range: "tenor", window: 10, key: "C" },
    },
  });

  // --- routing ---
  const vis = await page.evaluate(() => ({
    panel: getComputedStyle(document.getElementById("pitchPanel")).display,
    controls: getComputedStyle(document.getElementById("pitchControls")).display,
    boards: getComputedStyle(document.getElementById("boards")).display,
    melody: getComputedStyle(document.getElementById("melodyPanel")).display,
    sub: document.getElementById("subtab-voice-pitch").getAttribute("aria-selected"),
  }));
  t.ok("the pitch panel is shown on Voice", vis.panel !== "none", vis.panel);
  t.ok("its controls are shown", vis.controls !== "none", vis.controls);
  t.ok("the chord board is not", vis.boards === "none", vis.boards);
  t.ok("the melody panel is not", vis.melody === "none", vis.melody);
  t.ok("the Pitch sub-tab is selected", vis.sub === "true", vis.sub);
  t.ok("play is disabled before any take", await page.$eval("#pitchPlay", (b) => b.disabled));

  // --- live: sing A4, then C5 ---
  await fakeMicrophone(page, 440);
  await page.click("#pitchRecord");
  t.ok("record starts recording", (await page.waitForFunction(
    () => document.getElementById("pitchPanel").dataset.state === "recording", { timeout: 5000 }
  ).then(() => true, () => false)));
  t.ok("the readout names A4", await waitForNote(page, "A4"), await noteText(page));
  await settle(1800);
  const cents = await page.$eval("#pitchNote", (n) => Number(n.dataset.cents));
  t.ok("an in-tune A reads close to 0 cents", Math.abs(cents) <= 5, `${cents}¢`);
  const onA = await tracePixelsAt(page, 69, 120, "in");
  const offA = await tracePixelsAt(page, 57);
  t.ok("an in-tune A4 is drawn in its lane, in the in-tune colour", onA > 20, `${onA} px`);
  t.ok("and not an octave below it", offA === 0, `${offA} px`);
  t.ok("none of it is drawn as out of tune", (await tracePixelsAt(page, 69, 120, "off")) === 0);
  const inTuneRGB = await tokenRGB(page, "--pitch-in-tune");
  t.ok("the A4 key is lit in the in-tune colour", near(await keyColour(page, 69), inTuneRGB),
    JSON.stringify(await keyColour(page, 69)));
  t.ok("its neighbours are not", !near(await keyColour(page, 71), inTuneRGB) && !near(await keyColour(page, 67), inTuneRGB));
  t.ok("the readout card says in tune",
    (await page.$eval("#pitchCard", (c) => c.dataset.tune)) === "in");

  await page.evaluate(() => window.__fakeMic.setFreq(523.25));
  t.ok("the readout follows to C5", await waitForNote(page, "C5"), await noteText(page));
  await settle(1500);
  const onC = await tracePixelsAt(page, 72, 60);
  t.ok("the line moves to the C5 lane", onC > 10, `${onC} px`);

  // --- stop releases the microphone ---
  await page.click("#pitchStop");
  await settle(300);
  t.ok("stop returns to idle", (await state(page)) === "idle", await state(page));
  const ended = await page.evaluate(() => window.__fakeMic.tracks.every((tr) => tr.readyState === "ended"));
  t.ok("stop ends the microphone track", ended);
  t.ok("play is enabled once there is a take", !(await page.$eval("#pitchPlay", (b) => b.disabled)));

  // --- replay comes from the take, not the microphone ---
  await page.click("#pitchPlay");
  t.ok("play starts playback", (await state(page)) === "playing", await state(page));
  t.ok("replay shows the A the take began with", await waitForNote(page, "A4", 3000), await noteText(page));
  t.ok("then the C it moved to", await waitForNote(page, "C5", 6000), await noteText(page));
  t.ok("playback stops at the end of the take", (await page.waitForFunction(
    () => document.getElementById("pitchPanel").dataset.state === "idle", { timeout: 6000 }
  ).then(() => true, () => false)));

  // --- scrubbing: drag the graph right to go back in time ---
  const box = await page.evaluate(() => {
    const c = document.getElementById("pitchCanvas");
    const r = c.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: +c.dataset.graphRight - +c.dataset.graphLeft };
  });
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  // 10s across the graph; 2.5s back lands in the A part of the take.
  await page.mouse.move(box.x + box.w * 0.25, box.y, { steps: 8 });
  await page.mouse.up();
  t.ok("dragging back scrubs into the A", (await noteText(page)) === "A4", await noteText(page));
  t.ok("and the line there is in the A4 lane", (await tracePixelsAt(page, 69, 40)) > 5);

  // --- leaving the tab mid-take releases the microphone ---
  await page.click("#pitchRecord");
  await page.waitForFunction(() => document.getElementById("pitchPanel").dataset.state === "recording");
  await page.click("#tab-instrument-piano");
  await settle(300);
  const released = await page.evaluate(() => window.__fakeMic.tracks.every((tr) => tr.readyState === "ended"));
  t.ok("leaving the tab ends the microphone track", released);
  t.ok("and finishes the take", (await state(page)) === "idle", await state(page));
  t.ok("the panel is hidden on Piano",
    await page.$eval("#pitchPanel", (p) => getComputedStyle(p).display === "none"));

  // --- a quiet microphone is still tracked; a dead one says so ---
  // Laptop microphones with auto-gain off deliver singing around -45 dBFS. A
  // gate set for test tones once swallowed real voices entirely: the take
  // recorded, and the graph stayed empty.
  await page.click("#tab-instrument-voice");
  await fakeMicrophone(page, 440, 0.01);
  await page.click("#pitchRecord");
  t.ok("a -45 dBFS voice still reads A4", await waitForNote(page, "A4"), await noteText(page));
  await page.click("#pitchStop");
  await fakeMicrophone(page, 440, 0);
  await page.click("#pitchRecord");
  const warned = await page.waitForFunction(
    () => /No sound is reaching/.test(document.getElementById("pitchStatus").textContent),
    { timeout: 6000 }
  ).then(() => true, () => false);
  t.ok("a silent input is reported, not just left blank", warned,
    await page.$eval("#pitchStatus", (s) => s.textContent));
  await page.click("#pitchStop");
  t.ok("a take with no pitch in it says so",
    /no pitch was found/.test(await page.$eval("#pitchStatus", (s) => s.textContent)));

  // --- the readout is calmer than the trace ---
  // A quarter-tone sharp of A4 with ±30 cents of vibrato crosses the A/A#
  // boundary eleven times a second. The trace should show that; the note
  // name should not flicker between the two.
  await fakeMicrophone(page, 440 * 2 ** (50 / 1200), 0.3, 30);
  await page.click("#pitchRecord");
  await settle(800);
  const names = [];
  for (let i = 0; i < 40; i++) {
    names.push(await noteText(page));
    await settle(50);
  }
  await page.click("#pitchStop");
  const changes = names.filter((n, i) => i && n !== names[i - 1]).length;
  t.ok("vibrato across a semitone boundary does not flicker the note name", changes <= 1,
    `${changes} changes: ${names.join(" ")}`);
  // A quarter-tone out is as far from a note as a pitch can be: the line
  // there must be drawn as out of tune.
  const offPx = await tracePixelsAt(page, 69.5, 160, "off");
  const inPx = await tracePixelsAt(page, 69.5, 160, "in");
  t.ok("a quarter-tone sharp is drawn in the out-of-tune colour", offPx > 20 && offPx > inPx * 3,
    `${offPx} off vs ${inPx} in`);

  // Wide vibrato centred on the note is in tune: the ear hears its centre.
  // Judged point by point, it striped green and orange five times a second.
  await fakeMicrophone(page, 440, 0.3, 30);
  await page.click("#pitchRecord");
  await settle(2500);
  await page.click("#pitchStop");
  const vibIn = await tracePixelsAt(page, 69, 200, "in");
  const vibOff = await tracePixelsAt(page, 69, 200, "off");
  t.ok("a centred ±30¢ vibrato is drawn as in tune", vibIn > 40 && vibIn > vibOff * 4,
    `${vibIn} in vs ${vibOff} off`);

  // --- both themes: both line colours stand out, and from each other ---
  // "From each other" in lightness, not hue alone: that is what keeps in tune
  // and out of tune apart for a colour-blind singer.
  await settle(200);
  for (const light of [false, true]) {
    await page.evaluate((l) => document.body.classList.toggle("light-mode", l), light);
    await settle(100);
    const c = await lineContrast(page);
    const theme = light ? "light" : "dark";
    t.ok(`in-tune line contrast ≥ 4.5 in ${theme} theme`, c.inTune >= 4.5, c.inTune.toFixed(2));
    t.ok(`out-of-tune line contrast ≥ 4.5 in ${theme} theme`, c.offTune >= 4.5, c.offTune.toFixed(2));
    t.ok(`the two line colours differ in lightness (≥ 1.5) in ${theme} theme`, c.between >= 1.5, c.between.toFixed(2));
  }

  t.noErrors(page);
  await page.close();
}
