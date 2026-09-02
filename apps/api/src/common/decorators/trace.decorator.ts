import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';

// Kept in step with the `service.name` resource attribute set in
// instrumentation.ts and with pino.config.ts's `service` field. This used to
// be a bare literal, which meant OTEL_SERVICE_NAME renamed the service
// everywhere EXCEPT this tracer's instrumentation scope — a split that is
// invisible until someone filters a trace by name and finds half of it.
const tracer = trace.getTracer(process.env.OTEL_SERVICE_NAME || 'oathpath-api');

/**
 * Decorator to add tracing to a method
 */
export function Trace(spanName?: string) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor,
  ) {
    const originalMethod = descriptor.value;
    const name = spanName || `${target.constructor.name}.${propertyKey}`;

    descriptor.value = async function (...args: any[]) {
      return tracer.startActiveSpan(
        name,
        { kind: SpanKind.INTERNAL },
        async (span) => {
          try {
            const result = await originalMethod.apply(this, args);
            span.setStatus({ code: SpanStatusCode.OK });
            return result;
          } catch (error) {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: error instanceof Error ? error.message : 'Unknown error',
            });
            span.recordException(error as Error);
            throw error;
          } finally {
            span.end();
          }
        },
      );
    };

    return descriptor;
  };
}
