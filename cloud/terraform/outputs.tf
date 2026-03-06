output "alb_dns_name" {
  description = "ALB DNS name — create CNAME hive.vivtechnologies.com pointing here"
  value       = aws_lb.hive.dns_name
}

output "instance_id" {
  description = "EC2 instance ID"
  value       = aws_instance.hive.id
}

output "instance_public_ip" {
  description = "EC2 public IP (for SSH)"
  value       = aws_instance.hive.public_ip
}

output "instance_private_ip" {
  description = "EC2 private IP"
  value       = aws_instance.hive.private_ip
}

output "alb_sg_id" {
  description = "ALB security group ID"
  value       = aws_security_group.hive_alb.id
}

output "ec2_sg_id" {
  description = "EC2 security group ID"
  value       = aws_security_group.hive_ec2.id
}
