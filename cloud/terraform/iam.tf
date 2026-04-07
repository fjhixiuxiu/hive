# IAM role for Hive EC2 instance
# Permissions: Secrets Manager read (scoped) + SSM managed instance core

resource "aws_iam_role" "hive_ec2" {
  name = "${var.hive_name}-ec2-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name        = "${var.hive_name}-ec2-role"
    environment = var.env_name
    customer    = var.customer_name
  }
}

resource "aws_iam_role_policy" "hive_secrets" {
  name = "${var.hive_name}-secrets-read"
  role = aws_iam_role.hive_ec2.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue"
        ]
        Resource = "arn:aws:secretsmanager:us-east-1:140947722076:secret:hive/*"
      },
      {
        Effect = "Allow"
        Action = [
          "ec2:DescribeTags"
        ]
        Resource = "*"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "hive_ssm" {
  role       = aws_iam_role.hive_ec2.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "hive_ec2" {
  name = "${var.hive_name}-ec2-profile"
  role = aws_iam_role.hive_ec2.name

  tags = {
    Name        = "${var.hive_name}-ec2-profile"
    environment = var.env_name
    customer    = var.customer_name
  }
}
