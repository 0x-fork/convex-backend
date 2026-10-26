import type {
  CurrentPlanPriceResponse as MetricPrice,
  GetPricesPeriodResponse as PricesPeriod,
  MetricPriceAmount as PriceAmount,
} from "generatedApi";
import type { UsageSummaryRow } from "hooks/usageMetrics";

type UsageField = keyof Omit<UsageSummaryRow, "deploymentClass" | "region">;
type Metric = {
  name: string;
  field: UsageField | UsageField[];
  divisor?: number;
};
type MetricSection = Metric | ((prices: PricesPeriod["metrics"]) => Metric[]);

const BYTES_PER_GB = 2 ** 30;

const sections: Record<string, MetricSection> = {
  compute: computeMetrics,
  actionCompute: {
    name: "actionComputeConvexGbHours",
    field: ["actionComputeConvex", "actionComputeNode"],
  },
  functionCalls: { name: "functionCalls", field: "functionCalls" },
  // No divisor for search queries as the query already returns GB.
  searchQueries: { name: "searchQueryGb", field: "searchQueries" },
  databaseStorage: {
    name: "databaseStorageGb",
    field: "databaseStorage",
    divisor: BYTES_PER_GB,
  },
  databaseIO: {
    name: "databaseIoGb",
    field: "databaseIO",
    divisor: BYTES_PER_GB,
  },
  fileStorage: {
    name: "fileStorageGb",
    field: "fileStorage",
    divisor: BYTES_PER_GB,
  },
  searchStorage: {
    name: "searchStorageGb",
    field: "searchStorage",
    divisor: BYTES_PER_GB,
  },
  dataEgress: {
    name: "dataEgressGb",
    field: "dataEgress",
    divisor: BYTES_PER_GB,
  },
  auditLogBandwidth: {
    name: "auditLogBandwidthGb",
    field: "auditLogBandwidth",
    divisor: BYTES_PER_GB,
  },
};

function parseNonNegativeNumber(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function discountedRate(price: PriceAmount | undefined): number | undefined {
  if (!price) return undefined;
  const amount = parseNonNegativeNumber(price.amount);
  const discount = price.percentageDiscount ?? 0;
  if (
    amount === undefined ||
    !Number.isFinite(discount) ||
    discount < 0 ||
    discount > 1
  ) {
    return undefined;
  }
  return amount * (1 - discount);
}

function metricSpend(
  summary: UsageSummaryRow[],
  metric: Metric,
  price: MetricPrice | undefined,
): number | undefined {
  if (!price) return undefined;
  let gross = 0;
  for (const row of summary) {
    const fields = Array.isArray(metric.field) ? metric.field : [metric.field];
    const quantities = fields.map(
      (field) => row[field] / (metric.divisor ?? 1),
    );
    if (
      quantities.some((quantity) => !Number.isFinite(quantity) || quantity < 0)
    ) {
      return undefined;
    }
    const quantity = quantities.reduce((sum, value) => sum + value, 0);
    if (quantity === 0) continue;
    const amount =
      "rate" in price
        ? price.rate
        : "regionRate" in price
          ? price.regionRate[row.region]
          : price.deploymentClassRate[row.deploymentClass]?.regionRate[
              row.region
            ];
    if (!amount) return undefined;
    const rate = discountedRate(amount);
    if (rate === undefined) return undefined;
    gross += quantity * rate;
  }
  return Number.isFinite(gross) ? gross : undefined;
}

function computeMetrics(prices: PricesPeriod["metrics"]): Metric[] {
  const metrics: Metric[] = [
    {
      name: "queryMutationComputeGbHours",
      field: "queryMutationCompute",
    },
    { name: "actionComputeCpuGbHours", field: "actionComputeUser" },
    { name: "actionComputeNodeJsGbHours", field: "actionComputeNode" },
  ];

  return metrics.filter((metric) => prices[metric.name] !== undefined);
}

export function getUsageSpend(
  summary: UsageSummaryRow[] | undefined,
  sectionMetric: string,
  pricesPeriod: PricesPeriod | undefined,
): number | undefined {
  if (!summary || !pricesPeriod) return undefined;
  if (!Object.hasOwn(sections, sectionMetric)) {
    return undefined;
  }

  const section = sections[sectionMetric];
  const metrics =
    typeof section === "function" ? section(pricesPeriod.metrics) : [section];
  if (metrics.length === 0) return undefined;

  let total = 0;
  for (const metric of metrics) {
    const spend = metricSpend(
      summary,
      metric,
      pricesPeriod.metrics[metric.name],
    );
    if (spend === undefined) return undefined;
    total += spend;
  }
  return Number.isFinite(total) ? total : undefined;
}

export function formatSpend(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}
