import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import type { FastifyInstance } from 'fastify';

// preventServerStart: this app serves /metrics itself rather than the exporter's own HTTP server.
const prometheusExporter = new PrometheusExporter({ preventServerStart: true });
const meterProvider = new MeterProvider({ readers: [prometheusExporter] });
const meter = meterProvider.getMeter('ops-copilot');

export const httpRequestCounter = meter.createCounter('http_server_request_count', { description: 'HTTP requests by route, method, and status code' });
export const httpRequestDuration = meter.createHistogram('http_server_request_duration_ms', { description: 'HTTP request latency by route', unit: 'ms' });
export const toolErrorCounter = meter.createCounter('tool_error_count', { description: 'Agent tool calls that failed or were refused, by tool name' });
export const llmTokenCounter = meter.createCounter('llm_tokens_total', { description: 'LLM tokens consumed, by model and token type' });

export function registerMetricsRoute(app: FastifyInstance): void {
  app.get('/metrics', (request, reply) => {
    reply.hijack();
    prometheusExporter.getMetricsRequestHandler(request.raw, reply.raw);
  });
}
