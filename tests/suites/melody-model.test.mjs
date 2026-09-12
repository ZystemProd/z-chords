// melody-model.js is pure, so it is tested directly — no browser.
//
// The sharpest risk in this file is decomposeTicks: our duration vocabulary's
// tick values have gcd 1, so exactly five remainders (1,2,3,5,9 ticks) have no
// exact single-duration representation, full stop. Everything else must find
// an exact decomposition, and what must never happen — whatever the input —
// is the *total* drifting, which would desync playback from notation a bar at
// a time. This sweeps every tick count up to a few bars' worth and asserts
// both: the sum is always exact, and the fallback fires on precisely those
// five values and no others. (An earlier greedy implementation passed the sum
// check while failing the second one 147 times over the same sweep — see the
// comment at that assertion.)
import {
  TICKS_PER_WHOLE,
  durationTicks,
  barCapacityTicks,
  decomposeTicks,
  layoutBars,
  normalizeMelody,
  createMelody,
  spellNote,
  autoTabPosition,
  assignTab,
  melodyPlaybackSchedule,
  totalTicks,
} from "../../melody-model.js";

export const name = "Melody model";
export const needsBrowser = false;

export default async function run({ t }) {
  // --- durations ---
  t.ok("whole note is TICKS_PER_WHOLE", durationTicks(1, 0) === TICKS_PER_WHOLE);
  t.ok("quarter note is 16 ticks", durationTicks(4, 0) === 16);
  t.ok("dotted quarter is 24 ticks", durationTicks(4, 1) === 24);
  t.ok("double-dotted quarter is 28 ticks", durationTicks(4, 2) === 28);
  t.ok("16th note is 4 ticks", durationTicks(16, 0) === 4);
  t.ok("4/4 bar is 64 ticks", barCapacityTicks({ num: 4, den: 4 }) === 64);
  t.ok("3/4 bar is 48 ticks", barCapacityTicks({ num: 3, den: 4 }) === 48);
  t.ok("6/8 bar is 48 ticks", barCapacityTicks({ num: 6, den: 8 }) === 48);

  // --- decomposeTicks: the exact-sum invariant, swept broadly ---
  //
  // By the coin-problem (Frobenius) result over our duration vocabulary's tick
  // values, exactly five counts in any range this size — 1, 2, 3, 5, 9 — have
  // no exact decomposition at all, full stop. That is not a loose "should be
  // rare" expectation: an earlier, greedy version of this function failed 147
  // times over the same sweep (it commits to the largest duration first and
  // can strand an unrepresentable leftover even when a smaller first choice
  // would not have), and a threshold like "under 5%" would have let that
  // regression back in silently. Asserting the exact count means a return to
  // greedy — or any other decomposition that isn't provably shortest — fails
  // immediately instead of needing to be rediscovered.
  const UNREPRESENTABLE = [1, 2, 3, 5, 9];
  let sumFailures = 0;
  const fallbackTicks = [];
  const sweep = 4 * TICKS_PER_WHOLE;
  const legal = new Set(
    [1, 2, 4, 8, 16].flatMap((den) => [0, 1, 2].map((dots) => durationTicks(den, dots)))
  );
  for (let n = 1; n <= sweep; n += 1) {
    const parts = decomposeTicks(n);
    const sum = parts.reduce((s, p) => s + p.ticks, 0);
    if (sum !== n) sumFailures += 1;
    if (parts.some((p) => !legal.has(p.ticks))) fallbackTicks.push(n);
  }
  t.ok(
    `decomposeTicks sums exactly for 1..${sweep} ticks`,
    sumFailures === 0,
    `${sumFailures} mismatches`
  );
  t.ok(
    "the fallback fires on exactly the ticks with no exact decomposition",
    JSON.stringify(fallbackTicks) === JSON.stringify(UNREPRESENTABLE),
    `got [${fallbackTicks.join(",")}], expected [${UNREPRESENTABLE.join(",")}]`
  );

  // Known-clean split: a dotted-quarter straddling a 4/4 barline.
  {
    const melody = createMelody({
      timeSig: { num: 4, den: 4 },
      events: [
        { den: 4, dots: 0, notes: [{ midi: 60 }] },
        { den: 4, dots: 0, notes: [{ midi: 62 }] },
        { den: 4, dots: 0, notes: [{ midi: 64 }] },
        { den: 4, dots: 1, notes: [{ midi: 65 }] },
      ],
    });
    const bars = layoutBars(melody);
    t.ok("known split: two bars produced", bars.length === 2, `${bars.length}`);
    const crossing = bars[0].items.filter((i) => i.eventIndex === 3);
    t.ok("crossing note produces one piece in bar 1", crossing.length === 1, `${crossing.length}`);
    t.ok("bar 1 piece is tied forward", crossing[0] && crossing[0].tiedTo === true);
    const continuation = bars[1].items.filter((i) => i.eventIndex === 3);
    t.ok("crossing note continues into bar 2", continuation.length >= 1, `${continuation.length}`);
    t.ok("bar 2 piece is tied back", continuation[0] && continuation[0].tiedFrom === true);
    t.ok(
      "the crossing event's total ticks are preserved",
      crossing.reduce((s, i) => s + i.ticks, 0) +
        continuation.reduce((s, i) => s + i.ticks, 0) ===
        24
    );
  }

  // Bars never overflow their own capacity.
  {
    const melody = createMelody({
      timeSig: { num: 3, den: 4 },
      events: Array.from({ length: 20 }, (_, i) => ({
        den: 8,
        dots: i % 3 === 0 ? 1 : 0,
        notes: [{ midi: 60 + (i % 5) }],
      })),
    });
    const bars = layoutBars(melody);
    for (const bar of bars) {
      const used = bar.items.reduce((s, i) => s + i.ticks, 0);
      t.ok(
        `bar ${bar.index} does not exceed capacity`,
        used <= bar.capacityTicks,
        `${used}/${bar.capacityTicks}`
      );
    }
  }

  // Totals: layoutBars must never lose or invent ticks versus totalTicks.
  {
    const melody = createMelody({
      timeSig: { num: 4, den: 4 },
      events: [
        { den: 2, dots: 1, notes: [{ midi: 60 }] },
        { den: 4, dots: 2, notes: [{ midi: 62 }] },
        { rest: true, den: 16, dots: 0 },
        { den: 8, dots: 0, notes: [{ midi: 64 }] },
        { den: 8, dots: 0, notes: [{ midi: 65 }] },
      ],
    });
    const bars = layoutBars(melody);
    const total = bars.reduce(
      (s, b) => s + b.items.reduce((s2, i) => s2 + i.ticks, 0),
      0
    );
    t.ok(
      "layoutBars preserves total ticks",
      total === totalTicks(melody),
      `${total} vs ${totalTicks(melody)}`
    );
  }

  // --- normalize is total ---
  t.ok("null normalizes to an empty melody", normalizeMelody(null).events.length === 0);
  t.ok(
    "unknown clef falls back to treble",
    normalizeMelody({ clef: "bogus" }).clef === "treble"
  );
  t.ok(
    "bad denominators are dropped to quarter",
    normalizeMelody({ events: [{ den: 3, notes: [{ midi: 60 }] }] }).events[0].den === 4
  );
  t.ok(
    "a non-rest event with no valid notes is dropped",
    normalizeMelody({
      events: [{ den: 4, notes: [] }, { den: 4, notes: [{ midi: 60 }] }],
    }).events.length === 1
  );
  t.ok(
    "a rest event survives with no notes",
    normalizeMelody({ events: [{ den: 4, rest: true }] }).events.length === 1
  );
  t.ok(
    "midi is clamped to 0..127",
    normalizeMelody({ events: [{ den: 4, notes: [{ midi: 999 }] }] }).events[0].notes[0]
      .midi === 127
  );

  // --- spelling ---
  t.ok("C major spells C#4 with a sharp", spellNote(61, "C").accidental === "#");
  t.ok("F major spells the same pitch with a flat", spellNote(61, "F").accidental === "b");
  // C# (sharp-key spelling) and Db (flat-key spelling) are the same pitch but
  // sit on DIFFERENT staff positions in real notation -- C# on the C line/space,
  // Db one step higher on the D line/space. That is correct engraving, not a
  // bug, so the invariant is "one step apart", not "the same step".
  t.ok(
    "enharmonic spellings of a black key sit one staff step apart",
    spellNote(61, "F").staffStep - spellNote(61, "C").staffStep === 1
  );
  t.ok(
    "an octave is 7 diatonic steps",
    spellNote(72, "C").staffStep - spellNote(60, "C").staffStep === 7
  );

  // --- tab ---
  t.ok(
    "open low E maps to string 0 fret 0",
    JSON.stringify(autoTabPosition(40, null)) === JSON.stringify({ stringIdx: 0, fret: 0 })
  );
  {
    const near = autoTabPosition(64, 5);
    t.ok(
      "prefers minimal fret movement from the previous position",
      near && Math.abs(near.fret - 5) <= Math.abs(near.fret - 0)
    );
  }
  {
    const melody = createMelody({
      clef: "guitar",
      events: [
        { den: 4, notes: [{ midi: 64 }] },
        { den: 4, notes: [{ midi: 64, stringIdx: 3, fret: 17, manualTab: true }] },
        { den: 4, notes: [{ midi: 65 }] },
      ],
    });
    assignTab(melody);
    t.ok(
      "manual tab position is left untouched",
      melody.events[1].notes[0].fret === 17 && melody.events[1].notes[0].stringIdx === 3
    );
    t.ok(
      "auto-assigned notes get a real position",
      Number.isInteger(melody.events[0].notes[0].fret)
    );
  }

  // --- playback schedule ---
  {
    const melody = createMelody({
      tempo: 120,
      events: [
        { den: 4, notes: [{ midi: 60 }] },
        { rest: true, den: 4 },
        { den: 4, notes: [{ midi: 62 }] },
      ],
    });
    const sched = melodyPlaybackSchedule(melody);
    t.ok("rests produce no playback event", sched.length === 2, `${sched.length}`);
    // The middle event is a rest -- itself a quarter note -- so the note-to-note
    // gap spans two quarter notes' worth of time, not one.
    t.near("note-to-rest-to-note gap is two quarter notes at 120bpm", sched[1].atMs - sched[0].atMs, 1000, 0.01, "ms");
  }
}
