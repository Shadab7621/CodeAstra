"""Read-only sanity check: confirms AWS credentials work and lists basic resources."""
import os

import boto3
from dotenv import load_dotenv

load_dotenv()

profile = os.getenv("AWS_PROFILE", "codeastra")
region = os.getenv("AWS_REGION", "ap-south-1")
session = boto3.Session(profile_name=profile, region_name=region)

identity = session.client("sts").get_caller_identity()
print(f"Connected as: {identity['Arn']}")
print(f"Account:      {identity['Account']}")
print(f"Region:       {region}")

ec2 = session.client("ec2")
reservations = ec2.describe_instances()["Reservations"]
instances = [i for r in reservations for i in r["Instances"]]
print(f"EC2 instances: {len(instances)}")
for i in instances:
    print(f"  - {i['InstanceId']}  {i['InstanceType']}  {i['State']['Name']}")

buckets = session.client("s3").list_buckets()["Buckets"]
print(f"S3 buckets: {len(buckets)}")
for b in buckets:
    print(f"  - {b['Name']}")
