export type HealthResponse = {
  status: "ok";
  service: "api";
  timestamp: string;
};

export function healthResponse(): HealthResponse {
  return { status: "ok", service: "api", timestamp: new Date().toISOString() };
}
