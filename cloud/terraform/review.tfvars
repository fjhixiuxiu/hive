hive_name       = "hive"
env_name        = "hive"
secret_name     = "hive/env"
ebs_volume_size = 500

# AMI snapshotted from the pre-migration review-hive instance (preserves all files)
ami_id = "ami-02b871e7379fa8be7"

# Jenkins VPC (internal tools subnets)
vpc_id = "vpc-02651295c24f8bc7f"
subnet_ids = [
  "subnet-0d5dee6be35a20916", # internal-tools-1a, us-east-1a
  "subnet-094867cafbdcc387d", # internal-tools-1b, us-east-1b
]
ec2_subnet_id    = "subnet-0d5dee6be35a20916" # internal-tools-1a, us-east-1a
office_ssh_sg_id = "sg-043c84f65239ea620"     # toronto-office-jenkins-ssh
hive_fleet_sg_id = "sg-0eccb5c1f5c931f9c"     # hive-fleet-sg (Jenkins VPC)
