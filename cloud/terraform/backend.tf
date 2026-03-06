terraform {
  backend "s3" {
    bucket         = "viv-infrastructure-backend"
    dynamodb_table = "viv-infrastructure-state-lock"
    key            = "viv/hive"
    region         = "us-east-1"
  }
}
