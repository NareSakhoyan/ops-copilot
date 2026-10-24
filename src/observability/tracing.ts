import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { trace } from '@opentelemetry/api';
import { registerTelemetry } from 'ai';
import { OpenTelemetry } from '@ai-sdk/otel';
import { FastifyOtelInstrumentation } from '@fastify/otel';
import { z } from 'zod';

export const tracer = trace.getTracer('ops-copilot');

// The AI SDK only emits telemetry once an integration is registered; the tracer above
// follows whichever TracerProvider is globally active at span-creation time (production
// or a test's in-memory provider), so this registration works in both without special-casing.
registerTelemetry(new OpenTelemetry({ tracer }));

// instrumentHooks is off: per-lifecycle-hook spans add noise without value here.
export const fastifyOtelInstrumentation = new FastifyOtelInstrumentation({
  instrumentHooks: false,
  requestHook: (span, request) => { span.setAttribute('request_id', request.id); },
});

let sdk: NodeSDK | undefined;

export function startTracing(environment: NodeJS.ProcessEnv = process.env): void {
  const config = z.object({
    OTEL_EXPORTER_OTLP_ENDPOINT: z.url().default('http://127.0.0.1:4318'),
    OTEL_SERVICE_NAME: z.string().trim().min(1).default('ops-copilot'),
  }).parse(environment);
  sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: config.OTEL_SERVICE_NAME }),
    traceExporter: new OTLPTraceExporter({ url: `${config.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces` }),
    // The explicit service name above is all the resource identification this app needs;
    // host/env/process auto-detection is unnecessary work on every startup.
    autoDetectResources: false,
  });
  sdk.start();
}

export async function shutdownTracing(): Promise<void> {
  await sdk?.shutdown();
  sdk = undefined;
}
