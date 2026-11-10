const prefix = "https://www.googleapis.com/auth/googlehealth.";

/** Every read scope on https://developers.google.com/health/scopes. */
export const readScopes = [
  "activity_and_fitness.readonly",
  "ecg.readonly",
  "health_metrics_and_measurements.readonly",
  "irn.readonly",
  "location.readonly",
  "nutrition.readonly",
  "profile.readonly",
  "settings.readonly",
  "sleep.readonly",
].map((scope) => prefix + scope);

/** Every write scope on https://developers.google.com/health/scopes. */
export const writeScopes = [
  "activity_and_fitness.writeonly",
  "health_metrics_and_measurements.writeonly",
  "logged_symptoms.writeonly",
  "mindfulness.writeonly",
  "nutrition.writeonly",
  "profile.writeonly",
  "reproductive_health.writeonly",
  "settings.writeonly",
  "sleep.writeonly",
].map((scope) => prefix + scope);

/** Expands a short scope such as `sleep.readonly` to its full URL. */
export function scopeUrl(scope: string): string {
  return scope.startsWith("https://") ? scope : prefix + scope;
}
