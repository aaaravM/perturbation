// Which survey fields the mover network (realbogus_v1) learned from, was calibrated on and was tested
// on: the split stored with its weights (backend/src/pxh/ml/weights/realbogus_v1.json,
// training.fields; docs/validation/movers.md). The five challenge targets were never trained on.
// Used only while candidates.json names this model.

export const SPLIT_MODEL = "realbogus_v1";

const TRAIN = [
  "bd-2mass-j04013766p2849529",
  "bd-2mass-j04430581-3202090",
  "bd-2mass-j13243553p6358281",
  "bd-2mass-j19555779p3215277",
  "bd-2mass-j21265916p7617440",
  "bd-ssspm-j1444-2019",
  "ctrl-02",
  "ctrl-04",
  "ctrl-06",
  "ctrl-07",
  "ctrl-08",
  "ctrl-09",
  "ctrl-10",
  "pm-eggr-467",
  "pm-g-170-12",
  "pm-g-176-40",
  "pm-g-193-27",
  "pm-g-249-28",
  "pm-g-266-89",
  "pm-g-32-7",
  "pm-g-7-17",
  "pm-l-127-97",
  "pm-l-532-21",
  "pm-lp-320-434",
  "pm-lp-639-1",
  "pm-ross-476",
  "pm-wolf-125",
  "var-dd-ser",
  "var-fu-oct",
  "var-v1840-ori",
  "var-v2586-ori",
];

const VALIDATION = [
  "bd-2mass-j00345684-0706013",
  "bd-2massi-j1721039p334415",
  "ctrl-01",
  "pm-apmpm-j2330-4737",
  "pm-lp-732-35",
  "pm-lp-817-26",
  "pm-wolf-1040",
  "var-v957-per",
];

const TEST = [
  "bd-2mass-j13153094-2649513",
  "bd-sips-j1936-5502",
  "ctrl-03",
  "ctrl-05",
  "pm-bdp66-34a",
  "pm-g-10-17",
  "pm-g-63-45",
  "pm-l-750-42",
  "var-v2893-sgr",
];

const TARGETS = ["barnards-star", "eps-indi-b", "wise-0855", "rw-aur", "r-dra"];

export type FieldRole = "train" | "validation" | "test" | "target";

export function fieldRole(model: string | null, field: string): FieldRole | null {
  if (model !== SPLIT_MODEL) return null;
  if (TRAIN.includes(field)) return "train";
  if (VALIDATION.includes(field)) return "validation";
  if (TEST.includes(field)) return "test";
  if (TARGETS.includes(field)) return "target";
  return null;
}

/** How the network relates to a field, in plain words. */
export const ROLE_WORDS: Record<FieldRole, string> = {
  train: "a field the network trained on",
  validation: "a field used to calibrate the network, not to train it",
  test: "a test field the network never trained on",
  target: "a challenge target the network never trained on",
};
