import discovery from "./discovery.json" with { type: "json" };

type DataTypeKind = "Interval" | "Sample" | "Daily" | "Session" | "Food";
type Operation =
  | "list"
  | "get"
  | "reconcile"
  | "rollUp"
  | "dailyRollUp"
  | "create"
  | "patch"
  | "batchDelete";

export type DataType = {
  slug: string;
  kind: DataTypeKind;
  /** Scope family, such as `sleep`; append `.readonly` or `.writeonly`. */
  scope: string;
  /**
   * Operations from https://developers.google.com/health/data-types. The personal-range types
   * appear only in the daily roll-up schema. Absent when Google documents none.
   */
  operations?: Operation[];
  /** Available only in the v4beta API. */
  beta?: boolean;
};

const read: Operation[] = ["list", "reconcile", "rollUp", "dailyRollUp"];
const readGet: Operation[] = ["list", "get", "reconcile", "rollUp", "dailyRollUp"];
const listReconcile: Operation[] = ["list", "reconcile"];
const rollUpOnly: Operation[] = ["rollUp", "dailyRollUp"];
const writes: Operation[] = ["create", "patch", "batchDelete"];

const activity = "activity_and_fitness";
const metrics = "health_metrics_and_measurements";

export const dataTypes: DataType[] = [
  { slug: "active-energy-burned", kind: "Interval", scope: activity, operations: read },
  { slug: "active-minutes", kind: "Interval", scope: activity, operations: read },
  { slug: "active-zone-minutes", kind: "Interval", scope: activity, operations: read },
  { slug: "activity-level", kind: "Interval", scope: activity, operations: listReconcile },
  { slug: "altitude", kind: "Interval", scope: activity, operations: read },
  { slug: "basal-energy-burned", kind: "Interval", scope: activity },
  { slug: "blood-glucose", kind: "Sample", scope: metrics, operations: readGet },
  { slug: "body-fat", kind: "Sample", scope: metrics, operations: [...readGet, ...writes] },
  {
    slug: "calories-in-heart-rate-zone",
    kind: "Interval",
    scope: activity,
    operations: rollUpOnly,
  },
  { slug: "core-body-temperature", kind: "Sample", scope: metrics, operations: readGet },
  {
    slug: "daily-heart-rate-variability",
    kind: "Daily",
    scope: metrics,
    operations: listReconcile,
  },
  { slug: "daily-heart-rate-zones", kind: "Daily", scope: metrics, operations: listReconcile },
  { slug: "daily-oxygen-saturation", kind: "Daily", scope: metrics, operations: listReconcile },
  { slug: "daily-respiratory-rate", kind: "Daily", scope: metrics, operations: listReconcile },
  { slug: "daily-resting-heart-rate", kind: "Daily", scope: metrics, operations: listReconcile },
  {
    slug: "daily-sleep-temperature-derivations",
    kind: "Daily",
    scope: metrics,
    operations: listReconcile,
  },
  { slug: "daily-vo2-max", kind: "Daily", scope: activity, operations: listReconcile },
  { slug: "distance", kind: "Interval", scope: activity, operations: read },
  { slug: "electrocardiogram", kind: "Session", scope: "ecg", operations: ["list"] },
  {
    slug: "exercise",
    kind: "Session",
    scope: activity,
    operations: ["list", "get", "reconcile", ...writes],
  },
  { slug: "floors", kind: "Interval", scope: activity, operations: ["reconcile", ...rollUpOnly] },
  { slug: "food", kind: "Food", scope: "nutrition", operations: ["list", "get"] },
  { slug: "food-measurement-unit", kind: "Food", scope: "nutrition", operations: ["list", "get"] },
  { slug: "heart-rate", kind: "Sample", scope: metrics, operations: read },
  { slug: "heart-rate-variability", kind: "Sample", scope: metrics, operations: listReconcile },
  {
    slug: "heart-rate-variability-personal-range",
    kind: "Daily",
    scope: metrics,
    operations: ["dailyRollUp"],
  },
  {
    slug: "height",
    kind: "Sample",
    scope: metrics,
    operations: ["list", "get", "reconcile", ...writes],
  },
  {
    slug: "hydration-log",
    kind: "Session",
    scope: "nutrition",
    operations: [...readGet, ...writes],
  },
  { slug: "irregular-rhythm-notification", kind: "Session", scope: "irn", operations: ["list"] },
  { slug: "menstrual-period", kind: "Interval", scope: "reproductive_health", operations: writes },
  { slug: "moods", kind: "Sample", scope: "mindfulness", operations: writes },
  {
    slug: "nutrition-log",
    kind: "Session",
    scope: "nutrition",
    operations: [...readGet, ...writes],
  },
  { slug: "ovulation-test", kind: "Sample", scope: "reproductive_health", operations: writes },
  { slug: "oxygen-saturation", kind: "Sample", scope: metrics, operations: listReconcile },
  {
    slug: "respiratory-rate-sleep-summary",
    kind: "Sample",
    scope: metrics,
    operations: listReconcile,
  },
  {
    slug: "resting-heart-rate-personal-range",
    kind: "Daily",
    scope: metrics,
    operations: ["dailyRollUp"],
  },
  { slug: "run-vo2-max", kind: "Sample", scope: activity, operations: read },
  { slug: "sedentary-period", kind: "Interval", scope: activity, operations: read },
  {
    slug: "skin-temperature-sensors",
    kind: "Sample",
    scope: metrics,
    operations: ["list"],
    beta: true,
  },
  {
    slug: "sleep",
    kind: "Session",
    scope: "sleep",
    operations: ["list", "get", "reconcile", ...writes],
  },
  { slug: "steps", kind: "Interval", scope: activity, operations: read },
  { slug: "swim-lengths-data", kind: "Interval", scope: activity, operations: read },
  { slug: "symptoms", kind: "Sample", scope: "logged_symptoms", operations: writes },
  { slug: "time-in-heart-rate-zone", kind: "Interval", scope: activity, operations: read },
  { slug: "total-calories", kind: "Interval", scope: activity, operations: rollUpOnly },
  { slug: "vo2-max", kind: "Sample", scope: activity, operations: listReconcile },
  { slug: "weight", kind: "Sample", scope: metrics, operations: [...readGet, ...writes] },
];

const bySlug = new Map(dataTypes.map((type) => [type.slug, type]));

function findDataType(slug: string): DataType | undefined {
  return bySlug.get(slug);
}

/** The DataPoint field that holds a data type's payload, such as `heartRate`. */
export function dataPointField(slug: string): string {
  return slug.replace(/-([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());
}

/** Picks v4beta for beta-only data types unless the caller chose a version. */
export function apiVersionFor(slug: string, requested?: "v4" | "v4beta"): "v4" | "v4beta" {
  return requested ?? (findDataType(slug)?.beta ? "v4beta" : "v4");
}

export const discoveryRevision = discovery.revision;
