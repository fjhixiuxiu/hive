# Hive fleet EC2 instance — t3.large, Ubuntu 22.04, 50GB gp3 EBS.

resource "aws_instance" "hive" {
  ami                    = var.ami_id
  instance_type          = var.instance_type
  key_name               = var.key_name
  iam_instance_profile   = aws_iam_instance_profile.hive_ec2.name
  subnet_id              = var.ec2_subnet_id
  associate_public_ip_address = true

  vpc_security_group_ids = [
    aws_security_group.hive_ec2.id,
    var.office_ssh_sg_id,
  ]

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.ebs_volume_size
    delete_on_termination = false
    encrypted             = true

    tags = {
      Name        = "hive-fleet-root"
      environment = var.env_name
      customer    = var.customer_name
    }
  }

  user_data = base64encode(file("${path.module}/../scripts/init.sh"))

  tags = {
    Name        = "hive-fleet"
    environment = var.env_name
    customer    = var.customer_name
    service     = "hive"
  }

  lifecycle {
    ignore_changes = [
      user_data, # Only runs on first boot
      ami,       # Prevent accidental instance replacement
    ]
  }
}
