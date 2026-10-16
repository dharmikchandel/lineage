// Demo inputs. All are SYNTHETIC test inputs written by us, never real articles,
// so they are stored with synthetic=true and badged in the UI.
export interface Preset {
  id: string;
  label: string;
  hint: string;
  text: string;
}

export const PRESETS: Preset[] = [
  {
    id: "nasa-2026",
    label: "NASA darkness, 2026 edition",
    hint: "a new mutation of a 2012 hoax",
    text: "NASA confirms Earth will go dark for 15 days in November 2026, according to a 1,000-page report sent to the White House",
  },
  {
    id: "nasa-second",
    label: "…and another mutation",
    hint: "run after the first one",
    text: "NASA warns the whole planet will be in total darkness for 20 days this December, citing its 1,000-page White House report",
  },
  {
    id: "gates-correction",
    label: "Gates' 11 rules, credited correctly",
    hint: "a correction, not a mutation",
    text: "Charles J. Sykes wrote a list of rules kids won't learn in school, starting with 'Life is not fair; get used to it.'",
  },
  {
    id: "unrelated",
    label: "Something unrelated",
    hint: "the graph should say Unknown",
    text: "Drinking three cups of coffee a day adds ten years to your life",
  },
];
