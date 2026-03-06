variable "env_name" {
  description = "Environment name for tagging"
  type        = string
  default     = "hive"
}

variable "customer_name" {
  description = "Customer name for tagging"
  type        = string
  default     = "viv"
}

variable "vpc_id" {
  description = "VPC ID"
  type        = string
  default     = "vpc-bf97f3c6"
}

variable "subnet_ids" {
  description = "Subnet IDs for ALB (minimum 2 AZs)"
  type        = list(string)
  default = [
    "subnet-12f3a75a",           # us-east-1b
    "subnet-03f3b75e5489f36f5",  # us-east-1c
  ]
}

variable "ec2_subnet_id" {
  description = "Subnet for EC2 instance"
  type        = string
  default     = "subnet-12f3a75a" # us-east-1b
}

variable "instance_type" {
  description = "EC2 instance type"
  type        = string
  default     = "t3.large"
}

variable "ami_id" {
  description = "Ubuntu 22.04 AMI ID"
  type        = string
  default     = "ami-04680790a315cd58d"
}

variable "key_name" {
  description = "SSH key pair name"
  type        = string
  default     = "jenkins"
}

variable "certificate_arn" {
  description = "ACM certificate ARN for *.vivtechnologies.com"
  type        = string
  default     = "arn:aws:acm:us-east-1:140947722076:certificate/2bd943c9-7692-430b-b46b-b9a5cee983f3"
}

variable "office_ssh_sg_id" {
  description = "Existing office SSH security group ID"
  type        = string
  default     = "sg-0809ef61cbd90123e" # toronto-office-dev-ssh
}

variable "office_cidrs" {
  description = "Office IP CIDRs for ALB HTTPS access"
  type        = list(string)
  default = [
    "206.223.160.14/32",
    "72.137.131.6/32",
  ]
}

variable "ebs_volume_size" {
  description = "Root EBS volume size in GB"
  type        = number
  default     = 500
}
