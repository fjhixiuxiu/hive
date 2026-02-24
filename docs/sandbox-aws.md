# AWS access for the sandbox user

The sandbox user may need AWS access for CI checks, log reading, or deployments. Use an **IAM user with minimal permissions** — never share your main user's credentials.

## Decide what access you need

Most coding fleets only need read access. Only add write permissions if your fleet actually deploys.

| Use case | Permissions needed |
|---|---|
| Read CI/build logs | CodeBuild read, CodePipeline read |
| Read ECS service logs | ECS read, CloudWatch Logs read |
| Check deployment status | CodePipeline read, ECS read |
| Read secrets (for debugging) | SecretsManager read (specific secrets only) |
| Deploy (trigger pipelines) | CodePipeline start, ECS update-service |
| Full dev access | PowerUserAccess (not recommended) |

## Create an IAM user

### Read-only (safest)

Create an IAM user with read-only access to CI/CD and logs:

```bash
# Create the user (no console access)
aws iam create-user --user-name hivebot

# Create a policy for read-only CI/CD + logs
cat > /tmp/hivebot-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadCI",
      "Effect": "Allow",
      "Action": [
        "codepipeline:GetPipeline",
        "codepipeline:GetPipelineState",
        "codepipeline:GetPipelineExecution",
        "codepipeline:ListPipelineExecutions",
        "codebuild:BatchGetBuilds",
        "codebuild:ListBuildsForProject"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ReadECS",
      "Effect": "Allow",
      "Action": [
        "ecs:DescribeServices",
        "ecs:DescribeTasks",
        "ecs:ListTasks",
        "ecs:DescribeTaskDefinition"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ReadLogs",
      "Effect": "Allow",
      "Action": [
        "logs:GetLogEvents",
        "logs:FilterLogEvents",
        "logs:DescribeLogGroups",
        "logs:DescribeLogStreams"
      ],
      "Resource": "*"
    }
  ]
}
EOF

aws iam put-user-policy \
  --user-name hivebot \
  --policy-name hivebot-readonly \
  --policy-document file:///tmp/hivebot-policy.json

# Create access keys
aws iam create-access-key --user-name hivebot
```

### Read + deploy (if your fleet deploys)

Add these actions to the policy above:

```json
{
  "Sid": "Deploy",
  "Effect": "Allow",
  "Action": [
    "codepipeline:StartPipelineExecution",
    "ecs:UpdateService",
    "ecs:RegisterTaskDefinition"
  ],
  "Resource": "*"
}
```

You can scope `Resource` to specific pipeline/service ARNs instead of `"*"` for tighter control.

## Install the credentials

```bash
sudo -u hivebot -H bash -c 'mkdir -p ~/.aws && cat > ~/.aws/credentials << EOF
[default]
aws_access_key_id = AKIA...
aws_secret_access_key = ...
EOF'

sudo -u hivebot -H bash -c 'cat > ~/.aws/config << EOF
[default]
region = us-east-1
output = json
EOF'

# Lock it down
sudo -u hivebot chmod 700 /Users/hivebot/.aws
sudo -u hivebot chmod 600 /Users/hivebot/.aws/credentials
```

### Multiple accounts

If your fleet works across multiple AWS accounts, add profiles:

```bash
sudo -u hivebot -H bash -c 'cat >> ~/.aws/config << EOF

[profile account2]
region = us-east-1
output = json
EOF'

sudo -u hivebot -H bash -c 'cat >> ~/.aws/credentials << EOF

[account2]
aws_access_key_id = AKIA...
aws_secret_access_key = ...
EOF'
```

## Verify

```bash
sudo -u hivebot -H aws sts get-caller-identity
```

You should see the hivebot IAM user ARN.

## What this CAN'T do (with read-only policy)

- Create, modify, or delete any AWS resources
- Access S3 buckets
- Read or write Secrets Manager values
- Modify IAM users, roles, or policies
- Launch EC2 instances
- Change security groups or network config

## Rotation

Rotate access keys periodically:

```bash
# Create new key
aws iam create-access-key --user-name hivebot

# Update hivebot's credentials file with the new key

# Delete old key
aws iam delete-access-key --user-name hivebot --access-key-id AKIA_OLD_KEY
```

## Cleanup

To revoke all access:

```bash
aws iam delete-access-key --user-name hivebot --access-key-id AKIA...
aws iam delete-user-policy --user-name hivebot --policy-name hivebot-readonly
aws iam delete-user --user-name hivebot
```
