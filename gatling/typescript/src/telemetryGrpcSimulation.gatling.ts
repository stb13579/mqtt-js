import {
  atOnceUsers,
  constantUsersPerSec,
  exec,
  getParameter,
  scenario,
  simulation
} from "@gatling.io/core";
import { grpc, GrpcProtocolBuilder } from "@gatling.io/grpc";

interface Timestamp {
  seconds: number;
  nanos: number;
}

const DEFAULT_IMPORT_PATH = "../../protos";
const DEFAULT_PROTO = "telemetry.proto";

export default simulation((setUp) => {
  const host = getParameter("grpcHost", "localhost");
  const port = parseInt(getParameter("grpcPort", "50051"), 10);
  const useTls = getParameter("grpcTls", "false").toLowerCase() === "true";
  const fleetUsers = parseInt(getParameter("fleetUsers", "5"), 10);
  const historyUsers = parseInt(getParameter("historyUsers", "10"), 10);
  const targetWindowSeconds = parseInt(getParameter("windowSeconds", "900"), 10);
  const historyDurationSeconds = parseInt(getParameter("historyDurationSeconds", "600"), 10);
  const importPath = getParameter("protoImport", DEFAULT_IMPORT_PATH);
  const protoFile = getParameter("protoFile", DEFAULT_PROTO);

  const protocol: GrpcProtocolBuilder = grpc
    .protocol({
      target: `${host}:${port}`,
      useTls,
      plaintext: !useTls
    })
    .withProto({
      importPaths: [importPath],
      files: [protoFile]
    });

  const fleetSnapshotRequest = {
    includeMetrics: true
  };

  const now = Date.now();
  const historyRequest = {
    range: {
      start: timestampSeconds(now - historyDurationSeconds * 1000),
      end: timestampSeconds(now)
    },
    limit: 200
  };

  const aggregatesRequest = {
    range: {
      start: timestampSeconds(now - historyDurationSeconds * 1000),
      end: timestampSeconds(now)
    },
    window: {
      seconds: targetWindowSeconds
    }
  };

  const fleetScenario = scenario("Fleet snapshot users")
    .exec(
      grpc("Get fleet snapshot")
        .rpc({
          service: "telemetry.v1.TelemetryService",
          method: "GetFleetSnapshot",
          request: fleetSnapshotRequest
        })
        .check(grpc.status().isOk())
        .check(grpc.jsonBody("$.snapshots").count().gte(0))
    );

  const historyScenario = scenario("Telemetry history users")
    .exec(
      grpc("Query telemetry history")
        .rpc({
          service: "telemetry.v1.TelemetryService",
          method: "QueryTelemetryHistory",
          request: historyRequest
        })
        .check(grpc.status().isOk())
        .check(grpc.jsonBody("$.vehicleId").exists())
    )
    .exec(
      grpc("Historical aggregates")
        .rpc({
          service: "telemetry.v1.TelemetryService",
          method: "GetHistoricalAggregates",
          request: aggregatesRequest
        })
        .check(grpc.status().isOk())
        .check(grpc.jsonBody("$.buckets[*].metrics.TOTAL_DISTANCE_KM").findAll().exists())
    );

  setUp(
    fleetScenario.injectOpen(atOnceUsers(Math.max(1, fleetUsers))),
    historyScenario.injectOpen(constantUsersPerSec(Math.max(1, historyUsers)).during({ amount: 5, unit: "minutes" }))
  ).protocols(protocol);
});

function timestampSeconds(millis: number): Timestamp {
  const seconds = Math.floor(millis / 1000);
  const nanos = (millis % 1000) * 1_000_000;
  return { seconds, nanos };
}
