import { Checkbox } from "@ui/Checkbox";
import isEqual from "lodash/isEqual";
import { S3ExportTableSelector } from "./S3ExportTableSelector";
import { Selection } from "@convex-dev/platform/deploymentApi";
import {
  componentTablesIncluded,
  selectionWithComponents,
} from "./s3ExportSelection";
import { Button } from "@ui/Button";
import { Link } from "@ui/Link";
import { TextInput } from "@ui/TextInput";
import { Combobox, Option } from "@ui/Combobox";
import { Stepper } from "@ui/Stepper";
import {
  Disclosure,
  DisclosureButton,
  DisclosurePanel,
} from "@headlessui/react";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  EyeNoneIcon,
  EyeOpenIcon,
} from "@radix-ui/react-icons";
import { useFormik } from "formik";
import { useMemo, useState } from "react";
import * as Yup from "yup";
import {
  SyncPeriod,
  SyncSelection,
} from "system-udfs/convex/_system/frontend/common";
import { AnalyticsIntegration } from "@common/lib/integrationHelpers";
import {
  useCreateLogStream,
  useUpdateLogStream,
} from "@common/lib/integrationsApi";
import { toast } from "@common/lib/utils";
import { CopyButton } from "@common/elements/CopyButton";
import { SyncPeriodSelector } from "./SyncPeriodSelector";
import {
  exportRoot,
  glueDatabaseName,
  iamPolicy,
  useDeploymentName,
} from "./S3ExportStatus";

// Mirrors `validate_s3_bucket` in crates/local_backend/src/log_sinks.rs.
// https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html
const bucketSchema = Yup.string()
  .required("Bucket name is required")
  .min(3, "Bucket names are between 3 and 63 characters")
  .max(63, "Bucket names are between 3 and 63 characters")
  .matches(
    /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/,
    "Bucket names may only use lowercase letters, numbers, dots, and hyphens, and must start and end with a letter or number",
  )
  .test(
    "no-adjacent-periods",
    "Bucket names may not contain two adjacent periods",
    (value) => !value?.includes(".."),
  )
  .test(
    "not-ip-address",
    "Bucket names may not be formatted as an IP address",
    (value) => !/^\d{1,3}(\.\d{1,3}){3}$/.test(value ?? ""),
  )
  .test(
    "no-reserved-affix",
    "Bucket names may not start with `xn--` or `sthree-`, or end with `-s3alias` or `--ol-s3`",
    (value) =>
      !["xn--", "sthree-"].some((p) => value?.startsWith(p)) &&
      !["-s3alias", "--ol-s3"].some((suffix) => value?.endsWith(suffix)),
  );

// The fields each step collects, in step order.
const STEP_FIELDS = [
  ["bucket", "region", "prefix"],
  ["accessKeyId", "secretAccessKey", "roleArn"],
  ["period"],
] as const;

type CredentialMode = "role" | "accessKey";

/**
 * The same role the CloudFormation template creates, as Terraform for teams
 * that keep AWS in their own repo. Mirrors
 * ops/services/cloudformation/convex-integrations.yaml; change both together.
 */
export function terraformRole({
  externalId,
  bucket,
  exportPath,
  glueDatabase,
  createBucket = false,
}: {
  externalId: string;
  bucket: string;
  exportPath: string;
  glueDatabase: string;
  /** Matches the template's `CreateBucket`: the snippet makes the bucket too. */
  createBucket?: boolean;
}) {
  const convexAccount = CONVEX_S3_EXPORT_ROLE_ARN.split(":")[4];
  const bucketResources = createBucket
    ? `# Bucket for the export. Keep it if you remove Convex: it holds your data.
resource "aws_s3_bucket" "convex_export" {
  bucket = "${bucket}"
}

resource "aws_s3_bucket_public_access_block" "convex_export" {
  bucket                  = aws_s3_bucket.convex_export.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "convex_export" {
  bucket = aws_s3_bucket.convex_export.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "convex_export" {
  bucket = aws_s3_bucket.convex_export.id
  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
}

`
    : "";
  return `${bucketResources}# Role Convex assumes to write this deployment's data lake export.
resource "aws_iam_role" "convex_export" {
  name = "ConvexIntegrations-${externalId}"
  path = "/convex/"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { AWS = "arn:aws:iam::${convexAccount}:root" }
      Condition = {
        StringEquals = { "sts:ExternalId" = "${externalId}" }
        ArnEquals    = { "aws:PrincipalArn" = "${CONVEX_S3_EXPORT_ROLE_ARN}" }
      }
    }]
  })
}

resource "aws_iam_role_policy" "convex_export" {
  role = aws_iam_role.convex_export.id
  name = "data-lake"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "s3:GetBucketLocation"
        Resource = "arn:aws:s3:::${bucket}"
      },
      {
        Effect    = "Allow"
        Action    = "s3:ListBucket"
        Resource  = "arn:aws:s3:::${bucket}"
        Condition = { StringLike = { "s3:prefix" = ["${exportPath}/*", "${exportPath}"] } }
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"]
        Resource = "arn:aws:s3:::${bucket}/${exportPath}/*"
      },
      {
        Effect = "Allow"
        Action = [
          "glue:GetDatabase", "glue:CreateDatabase", "glue:GetTable", "glue:GetTables",
          "glue:CreateTable", "glue:UpdateTable", "glue:DeleteTable",
        ]
        Resource = [
          "arn:aws:glue:\${data.aws_region.current.name}:\${data.aws_caller_identity.current.account_id}:catalog",
          "arn:aws:glue:\${data.aws_region.current.name}:\${data.aws_caller_identity.current.account_id}:database/${glueDatabase}",
          "arn:aws:glue:\${data.aws_region.current.name}:\${data.aws_caller_identity.current.account_id}:table/${glueDatabase}/*",
        ]
      },
    ]
  })
}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

# Paste this into the Convex dashboard.
output "convex_export_role_arn" {
  value = aws_iam_role.convex_export.arn
}
`;
}

// Where the dashboard sends the admin to create the customer-side role. Both
// values come from ops/services/conductor/terraform and ops/vault/porter.tf.
const CLOUDFORMATION_TEMPLATE_URL =
  "https://convex-cloudformation-use1-prod.s3.us-east-1.amazonaws.com/convex-integrations/template.yaml";
export const CONVEX_S3_EXPORT_ROLE_ARN =
  "arn:aws:iam::715951115348:role/convex-s3-export-prod";

/**
 * CloudFormation quick-create link with every parameter filled in, so the
 * admin only reviews and clicks Create stack.
 */
export function quickCreateUrl({
  region,
  externalId,
  bucket,
  exportPath,
  glueDatabase,
  createBucket = false,
}: {
  region: string;
  externalId: string;
  bucket: string;
  /** `exportRoot(prefix, deploymentName)/data-lake`, the one path the role may touch. */
  exportPath: string;
  glueDatabase: string;
  /** The stack creates `bucket` in `region` instead of using an existing one. */
  createBucket?: boolean;
}) {
  const params = new URLSearchParams({
    templateURL: CLOUDFORMATION_TEMPLATE_URL,
    stackName: `ConvexIntegrations-${externalId.slice(0, 8)}`,
    param_ExternalId: externalId,
    param_BucketName: bucket,
    param_ExportPath: exportPath,
    param_ConvexRoleArn: CONVEX_S3_EXPORT_ROLE_ARN,
    param_GlueDatabase: glueDatabase,
    param_CreateBucket: String(createBucket),
  });
  return `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/quickcreate?${params}`;
}

export function S3ExportConfigurationForm({
  onClose,
  integration,
  onAddedIntegration,
}: {
  onClose: () => void;
  integration: Extract<AnalyticsIntegration, { kind: "s3Export" }>;
  onAddedIntegration?: () => void;
}) {
  const createLogStream = useCreateLogStream();
  const updateLogStream = useUpdateLogStream();
  const existingConfig = integration.existing?.config ?? null;
  const logStreamId = integration.existing?._id;

  const initialSelection: SyncSelection = {
    _other: "included",
    ...existingConfig?.selection,
    "": existingConfig?.selection[""] ?? {
      _other:
        existingConfig?.selection._other === "excluded"
          ? "excluded"
          : "included",
    },
  };

  const isNewIntegration = existingConfig === null || !logStreamId;

  const [showSecretAccessKey, setShowSecretAccessKey] = useState(false);
  // A saved export keeps its credential type. A new one starts on the role
  // path, which stores no secret.
  const [credentialMode, setCredentialMode] = useState<CredentialMode>(
    // A stored role export carries an empty access key ID, so the role fields
    // decide.
    existingConfig && existingConfig.roleExternalId === undefined
      ? "accessKey"
      : "role",
  );
  const deploymentName = useDeploymentName();

  const validationSchema = useMemo(
    () =>
      Yup.object().shape({
        bucket: bucketSchema,
        region: Yup.string().required("Region is required"),
        // IAM reads `*` and `?` as wildcards, which would widen the generated
        // policy beyond the export's directory.
        // Mirrors `validate_s3_prefix` in crates/local_backend/src/log_sinks.rs.
        prefix: Yup.string().matches(
          /^[^*?$]*$/,
          "Prefixes may not contain `*`, `?` or `$`",
        ),
        accessKeyId:
          credentialMode === "accessKey"
            ? Yup.string().required("Access key ID is required")
            : Yup.string(),
        secretAccessKey:
          credentialMode === "accessKey" && isNewIntegration
            ? Yup.string().required("Secret access key is required")
            : // Blank keeps the stored secret.
              Yup.string(),
        roleArn: Yup.string().matches(
          /^$|^arn:aws:iam::\d{12}:role\/.+$/,
          "Role ARNs look like arn:aws:iam::123456789012:role/convex/ConvexIntegrations-…",
        ),
      }),
    [isNewIntegration, credentialMode],
  );

  const formState = useFormik<{
    bucket: string;
    region: string;
    prefix: string;
    accessKeyId: string;
    secretAccessKey: string;
    roleArn: string;
    period: SyncPeriod;
    selection: SyncSelection;
  }>({
    initialValues: {
      bucket: existingConfig?.bucket ?? "",
      region: existingConfig?.region ?? "",
      prefix: existingConfig?.prefix ?? "",
      accessKeyId: existingConfig?.accessKeyId ?? "",
      secretAccessKey: "",
      roleArn: existingConfig?.roleArn ?? "",
      period: existingConfig?.period ?? "daily",
      selection: initialSelection,
    },
    onSubmit: async (values, helpers) => {
      helpers.setStatus(undefined);
      try {
        const selection = isEqual(values.selection, initialSelection)
          ? undefined
          : values.selection;
        const config = {
          bucket: values.bucket,
          region: values.region,
          prefix: values.prefix || null,
          period: values.period,
          // OpenAPI's flattened map type cannot represent the `_other` default.
          ...(selection ? { selection: selection as Selection } : {}),
        };

        if (isNewIntegration && credentialMode === "role") {
          // The export is created without its ARN so the backend can hand
          // back the ExternalId the CloudFormation stack needs.
          await createLogStream({
            logStreamType: "s3Export",
            ...config,
            roleArn: "",
          });
          onAddedIntegration?.();
          toast("success", "Export created. Open it to finish the AWS setup.");
        } else if (isNewIntegration) {
          await createLogStream({
            logStreamType: "s3Export",
            ...config,
            accessKeyId: values.accessKeyId,
            secretAccessKey: values.secretAccessKey,
          });
          onAddedIntegration?.();
          toast("success", "Export saved. The first sync is starting.");
        } else {
          // Omitting the secret keeps the one already stored; omitting the
          // ARN keeps the one already pasted.
          await updateLogStream(logStreamId, {
            logStreamType: "s3Export",
            period: values.period,
            ...(selection ? { selection: selection as Selection } : {}),
            ...(credentialMode === "accessKey" && values.secretAccessKey
              ? { secretAccessKey: values.secretAccessKey }
              : {}),
            ...(credentialMode === "role" &&
            values.roleArn !== existingConfig.roleArn
              ? { roleArn: values.roleArn }
              : {}),
          });
          toast(
            "success",
            credentialMode === "role" &&
              existingConfig.roleArn === "" &&
              values.roleArn !== ""
              ? "Role saved. The first sync is starting."
              : "Export updated.",
          );
        }
        onClose();
      } catch (e) {
        helpers.setStatus({
          error: e instanceof Error ? e.message : "Failed to save integration.",
        });
      }
    },
    validationSchema,
  });

  // Formik validates every field on each change; show a field's error only
  // once the user has left it or tried to save.
  const fieldError = (
    field: Exclude<keyof typeof formState.values, "selection">,
  ) =>
    formState.touched[field] || formState.submitCount > 0
      ? formState.errors[field]
      : undefined;
  const { bucket, region, prefix } = formState.values;
  const policy = iamPolicy({ bucket, region, prefix, deploymentName });
  // The first invalid field in a step, if any.
  const stepError = (step: number) =>
    STEP_FIELDS[step]
      .map((field) => {
        try {
          validationSchema.validateSyncAt(field, formState.values);
          return undefined;
        } catch (e) {
          return e instanceof Yup.ValidationError ? e.message : String(e);
        }
      })
      .find((error) => error !== undefined);
  // The policy can't be built without a valid destination.
  const destinationError = stepError(0);
  // A new export walks through the steps in order. A saved one opens on the
  // last step, so every earlier step is a click away.
  const [activeStep, setActiveStep] = useState(
    isNewIntegration ? 0 : STEP_FIELDS.length - 1,
  );
  const continueButton = (step: number) => (
    <Button
      variant="neutral"
      size="sm"
      className="self-start"
      onClick={async () => {
        await formState.setTouched(
          {
            ...formState.touched,
            ...Object.fromEntries(STEP_FIELDS[step].map((f) => [f, true])),
          },
          true,
        );
        if (stepError(step) === undefined) {
          setActiveStep(step + 1);
        }
      }}
    >
      Continue
    </Button>
  );
  // An existing export's destination is fixed, so only a new export's policy
  // can change after the user copies it.
  const [copiedPolicy, setCopiedPolicy] = useState<string>();
  const destinationChanged = !!copiedPolicy && copiedPolicy !== policy;
  // Match the destination fields enforced by `ensure_same_s3_destination`.
  const destinationFixed = !isNewIntegration;
  const destinationFixedDescription =
    "Fixed for this export. Delete it and create a new one to change this.";

  return (
    <form
      onSubmit={formState.handleSubmit}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pb-4">
        <Stepper activeStep={activeStep} onSelectStep={setActiveStep}>
          <Stepper.Step label="Destination">
            <TextInput
              value={bucket}
              onChange={formState.handleChange}
              label="Bucket name"
              placeholder="my-analytics-bucket"
              id="bucket"
              error={fieldError("bucket")}
              onBlur={formState.handleBlur}
              disabled={destinationFixed}
              description={
                destinationFixed
                  ? destinationFixedDescription
                  : "An existing S3 bucket. Convex doesn't create it."
              }
            />
            <div className="flex flex-col gap-1">
              <Combobox
                label="Region"
                labelHidden={false}
                options={AWS_REGIONS}
                selectedOption={region || null}
                setSelectedOption={async (value) => {
                  await formState.setFieldValue("region", value ?? "");
                  await formState.setFieldTouched("region", true, false);
                }}
                placeholder="Select the bucket's region"
                disabled={destinationFixed}
                allowCustomValue
                unknownLabel={(value) => value}
                buttonClasses="w-full bg-inherit"
              />
              {fieldError("region") && (
                <p className="text-xs text-content-errorSecondary" role="alert">
                  {fieldError("region")}
                </p>
              )}
            </div>
            <TextInput
              value={prefix}
              onChange={formState.handleChange}
              label="Prefix (optional)"
              placeholder="convex/"
              id="prefix"
              error={fieldError("prefix")}
              onBlur={formState.handleBlur}
              disabled={destinationFixed}
            />
            {!destinationError && (
              <p className="text-xs text-content-secondary">
                Convex writes Apache Iceberg tables to{" "}
                <code>
                  s3://{bucket}/{exportRoot(prefix, deploymentName)}/data-lake/
                </code>{" "}
                and registers them in the AWS Glue database{" "}
                <code>{glueDatabaseName(deploymentName)}</code>, which Convex
                creates.
              </p>
            )}
            {continueButton(0)}
          </Stepper.Step>
          <Stepper.Step label="AWS access">
            {isNewIntegration && (
              <div
                role="radiogroup"
                aria-label="AWS access method"
                className="flex gap-2"
              >
                {(
                  [
                    ["role", "IAM role (recommended)"],
                    ["accessKey", "Access keys"],
                  ] as const
                ).map(([mode, label]) => (
                  <Button
                    key={mode}
                    role="radio"
                    aria-checked={credentialMode === mode}
                    variant={credentialMode === mode ? "primary" : "neutral"}
                    size="sm"
                    onClick={() => setCredentialMode(mode)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            )}
            {credentialMode === "role" && isNewIntegration && (
              <p className="text-xs text-content-secondary">
                Save to create the export. Then open it to launch a
                CloudFormation stack in the bucket's AWS account and paste the
                role ARN it outputs. Convex stores no access keys.
              </p>
            )}
            {credentialMode === "role" && !isNewIntegration && (
              <>
                <RoleSetup
                  role={{
                    externalId: existingConfig.roleExternalId ?? "",
                    bucket,
                    exportPath: `${exportRoot(prefix, deploymentName)}/data-lake`,
                    glueDatabase: glueDatabaseName(deploymentName),
                  }}
                  region={region}
                />
                <TextInput
                  value={formState.values.roleArn}
                  onChange={formState.handleChange}
                  label="Role ARN"
                  id="roleArn"
                  placeholder="arn:aws:iam::123456789012:role/convex/ConvexIntegrations-…"
                  error={fieldError("roleArn")}
                  onBlur={formState.handleBlur}
                  description="From the stack's Outputs tab. The first sync starts once it is saved."
                />
              </>
            )}
            {credentialMode === "accessKey" && (
              <>
                <PolicyActions
                  policy={policy}
                  disabledReason={destinationError}
                  destinationChanged={destinationChanged}
                  onCopied={() => setCopiedPolicy(policy)}
                >
                  <ol className="flex list-[lower-alpha] flex-col gap-1 pl-4 text-xs text-content-secondary">
                    <li>
                      In the bucket's AWS account,{" "}
                      <Link
                        href="https://console.aws.amazon.com/iam/home#/users/create"
                        target="_blank"
                      >
                        create an IAM user
                      </Link>
                      .
                    </li>
                    <li>
                      Open the user, then choose Add permissions, Create inline
                      policy, and JSON. Paste this policy and save it.
                    </li>
                    <li>
                      Under Security credentials, create an access key for an
                      application running outside AWS. Copy both values: AWS
                      shows the secret only once.
                    </li>
                  </ol>
                </PolicyActions>
                <TextInput
                  value={formState.values.accessKeyId}
                  onChange={formState.handleChange}
                  label="Access Key ID"
                  placeholder="AKIAIOSFODNN7EXAMPLE"
                  id="accessKeyId"
                  error={fieldError("accessKeyId")}
                  onBlur={formState.handleBlur}
                  disabled={destinationFixed}
                  description={
                    destinationFixed ? destinationFixedDescription : undefined
                  }
                />
                <TextInput
                  value={formState.values.secretAccessKey}
                  onChange={formState.handleChange}
                  type={showSecretAccessKey ? "text" : "password"}
                  label={
                    isNewIntegration
                      ? "Secret Access Key"
                      : "Secret Access Key (stored)"
                  }
                  id="secretAccessKey"
                  className="max-w-full"
                  placeholder={
                    isNewIntegration ? undefined : "Leave blank to keep"
                  }
                  action={() => setShowSecretAccessKey(!showSecretAccessKey)}
                  Icon={showSecretAccessKey ? EyeNoneIcon : EyeOpenIcon}
                  iconTooltip={
                    showSecretAccessKey
                      ? "Hide secret access key"
                      : "Show secret access key"
                  }
                  error={fieldError("secretAccessKey")}
                  onBlur={formState.handleBlur}
                  description="Permissions can take a minute to apply. Convex retries automatically."
                />
              </>
            )}
            {continueButton(1)}
          </Stepper.Step>
          <Stepper.Step label="Sync settings">
            <div className="overflow-hidden rounded-sm border">
              <div className="flex flex-col gap-1 p-3">
                <label
                  htmlFor="includeComponentTables"
                  className="flex items-center gap-2 text-sm"
                >
                  <Checkbox
                    id="includeComponentTables"
                    aria-label="Include component tables"
                    checked={componentTablesIncluded(
                      formState.values.selection,
                    )}
                    disabled={formState.isSubmitting}
                    onChange={() =>
                      void formState.setFieldValue(
                        "selection",
                        selectionWithComponents(
                          formState.values.selection,
                          componentTablesIncluded(
                            formState.values.selection,
                          ) !== true,
                        ),
                      )
                    }
                  />
                  Include component tables
                </label>
                <p className="pl-6 text-xs text-content-secondary">
                  Include data from components like aggregates and workpools.
                </p>
              </div>
              <Disclosure>
                <DisclosureButton className="flex w-full items-center justify-between gap-2 border-t px-3 py-2 text-left text-xs font-medium">
                  {({ open }) => (
                    <>
                      <span>Choose specific tables</span>
                      <span className="flex items-center gap-2 text-content-secondary">
                        Advanced
                        {open ? <ChevronUpIcon /> : <ChevronDownIcon />}
                      </span>
                    </>
                  )}
                </DisclosureButton>
                <DisclosurePanel className="border-t p-3">
                  <S3ExportTableSelector
                    selection={formState.values.selection}
                    onChange={(selection) =>
                      void formState.setFieldValue("selection", selection)
                    }
                    disabled={formState.isSubmitting}
                  />
                </DisclosurePanel>
              </Disclosure>
            </div>
            {!isNewIntegration &&
              !isEqual(formState.values.selection, initialSelection) && (
                <p className="text-xs text-content-secondary" role="status">
                  Saving keeps the progress of tables you already export. Tables
                  you add sync from the start, and tables you remove stay in S3
                  but stop updating.
                </p>
              )}
            <SyncPeriodSelector
              value={formState.values.period}
              onChange={async (period) => {
                await formState.setFieldValue("period", period);
              }}
            />
          </Stepper.Step>
        </Stepper>
      </div>
      <div className="flex items-center justify-end gap-2 px-6 py-4">
        {formState.status?.error && (
          <p className="text-sm text-content-errorSecondary" role="alert">
            {formState.status.error}
          </p>
        )}
        <Button
          variant="neutral"
          onClick={onClose}
          disabled={formState.isSubmitting}
        >
          Cancel
        </Button>
        <Button
          variant="primary"
          type="submit"
          aria-label="save"
          onClick={async () => {
            // Open the first step with an error, since the others are
            // collapsed.
            const errors = await formState.validateForm();
            const step = STEP_FIELDS.findIndex((fields) =>
              fields.some((field) => errors[field]),
            );
            if (step !== -1) {
              setActiveStep(step);
            }
          }}
          disabled={!formState.dirty || formState.isSubmitting}
          loading={formState.isSubmitting}
        >
          Save
        </Button>
      </div>
    </form>
  );
}

function RoleSetup({
  role,
  region,
}: {
  role: Parameters<typeof terraformRole>[0];
  region: string;
}) {
  const { externalId } = role;
  const terraform = terraformRole(role);
  return (
    <>
      <ol className="flex list-[lower-alpha] flex-col gap-1 pl-4 text-xs text-content-secondary">
        <li>
          Open AWS below. CloudFormation opens with the External ID, bucket and
          export path filled in.
        </li>
        <li>
          Tick the IAM acknowledgement and choose Create stack. It takes one to
          two minutes.
        </li>
        <li>
          On the stack's Outputs tab, copy <code>RoleArn</code> and paste it
          here.
        </li>
      </ol>
      <div className="flex flex-col gap-1">
        <TextInput
          value={externalId}
          onChange={() => {}}
          label="External ID"
          id="externalId"
          disabled
          description="Generated by Convex for this export. The stack's trust policy requires it."
        />
        <CopyButton text={externalId} label="Copy External ID" size="sm" />
      </div>
      <Button
        href={quickCreateUrl({ region, ...role })}
        target="_blank"
        variant="neutral"
        size="sm"
        className="self-start"
      >
        Open in AWS
      </Button>
      <Disclosure as="div" className="flex flex-col gap-2">
        <DisclosureButton
          as={Button}
          variant="neutral"
          size="sm"
          className="self-start"
        >
          {({ open }) => (
            <>
              {open ? "Hide Terraform" : "Using Terraform or another IaC tool?"}
            </>
          )}
        </DisclosureButton>
        <DisclosurePanel className="flex flex-col gap-2">
          <p className="text-xs text-content-secondary">
            Add this to your Terraform instead of running the stack. It creates
            the same role. Apply it, then paste the{" "}
            <code>convex_export_role_arn</code> output below.
          </p>
          <CopyButton text={terraform} label="Copy Terraform" size="sm" />
          <pre className="scrollbar max-h-64 overflow-auto rounded-sm border bg-background-tertiary p-2 font-mono text-xs">
            {terraform}
          </pre>
        </DisclosurePanel>
      </Disclosure>
    </>
  );
}

function PolicyActions({
  policy,
  disabledReason,
  destinationChanged,
  onCopied,
  children,
}: {
  policy: string;
  disabledReason: string | undefined;
  destinationChanged: boolean;
  onCopied: () => void;
  children: React.ReactNode;
}) {
  return (
    <Disclosure as="div" className="flex flex-col gap-2">
      {children}
      <div className="flex flex-wrap items-center gap-2">
        <CopyButton
          text={policy}
          label="Copy policy"
          size="sm"
          disabled={disabledReason !== undefined}
          onCopied={onCopied}
        />
        <DisclosureButton as={Button} variant="neutral" size="sm">
          {({ open }) => <>{open ? "Hide policy" : "Show policy"}</>}
        </DisclosureButton>
        <p className="text-xs text-content-secondary" aria-live="polite">
          {disabledReason ??
            (destinationChanged &&
              "Destination changed. Copy the updated policy and replace the old one. Your access key stays the same.")}
        </p>
      </div>
      <DisclosurePanel>
        <pre className="scrollbar max-h-64 overflow-auto rounded-sm border bg-background-tertiary p-2 font-mono text-xs">
          {policy}
        </pre>
      </DisclosurePanel>
    </Disclosure>
  );
}

// AWS regions with S3 and Glue. Other region codes can be typed in.
const AWS_REGIONS: Option<string>[] = [
  ["us-east-1", "US East (N. Virginia)"],
  ["us-east-2", "US East (Ohio)"],
  ["us-west-1", "US West (N. California)"],
  ["us-west-2", "US West (Oregon)"],
  ["af-south-1", "Africa (Cape Town)"],
  ["ap-east-1", "Asia Pacific (Hong Kong)"],
  ["ap-south-1", "Asia Pacific (Mumbai)"],
  ["ap-south-2", "Asia Pacific (Hyderabad)"],
  ["ap-southeast-1", "Asia Pacific (Singapore)"],
  ["ap-southeast-2", "Asia Pacific (Sydney)"],
  ["ap-southeast-3", "Asia Pacific (Jakarta)"],
  ["ap-southeast-4", "Asia Pacific (Melbourne)"],
  ["ap-northeast-1", "Asia Pacific (Tokyo)"],
  ["ap-northeast-2", "Asia Pacific (Seoul)"],
  ["ap-northeast-3", "Asia Pacific (Osaka)"],
  ["ca-central-1", "Canada (Central)"],
  ["ca-west-1", "Canada West (Calgary)"],
  ["eu-central-1", "Europe (Frankfurt)"],
  ["eu-central-2", "Europe (Zurich)"],
  ["eu-west-1", "Europe (Ireland)"],
  ["eu-west-2", "Europe (London)"],
  ["eu-west-3", "Europe (Paris)"],
  ["eu-south-1", "Europe (Milan)"],
  ["eu-south-2", "Europe (Spain)"],
  ["eu-north-1", "Europe (Stockholm)"],
  ["il-central-1", "Israel (Tel Aviv)"],
  ["me-south-1", "Middle East (Bahrain)"],
  ["me-central-1", "Middle East (UAE)"],
  ["sa-east-1", "South America (São Paulo)"],
].map(([value, name]) => ({ value, label: `${name} ${value}` }));
