# Security group for ALB — restricts HTTPS to office IPs only.
# EC2 reuses the existing toronto-office-prod-ssh SG for SSH access.

resource "aws_security_group" "hive_alb" {
  name        = "hive-alb-sg"
  description = "Hive ALB - HTTPS from office IPs"
  vpc_id      = var.vpc_id

  tags = {
    Name        = "hive-alb-sg"
    environment = var.env_name
    customer    = var.customer_name
  }
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  for_each = toset(var.office_cidrs)

  security_group_id = aws_security_group.hive_alb.id
  description       = "HTTPS from office"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  cidr_ipv4         = each.value
}

resource "aws_vpc_security_group_egress_rule" "alb_to_ec2" {
  security_group_id            = aws_security_group.hive_alb.id
  description                  = "To EC2 on port 3000"
  from_port                    = 3000
  to_port                      = 3000
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.hive_ec2.id
}

# Security group for EC2 — inbound from ALB on 3000, all outbound
resource "aws_security_group" "hive_ec2" {
  name        = "hive-ec2-sg"
  description = "Hive EC2 - inbound from ALB on 3000"
  vpc_id      = var.vpc_id

  tags = {
    Name        = "hive-ec2-sg"
    environment = var.env_name
    customer    = var.customer_name
  }
}

resource "aws_vpc_security_group_ingress_rule" "ec2_from_alb" {
  security_group_id            = aws_security_group.hive_ec2.id
  description                  = "From ALB on port 3000"
  from_port                    = 3000
  to_port                      = 3000
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.hive_alb.id
}

resource "aws_vpc_security_group_egress_rule" "ec2_all_outbound" {
  security_group_id = aws_security_group.hive_ec2.id
  description       = "All outbound"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}
