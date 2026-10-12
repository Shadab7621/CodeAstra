// What is actually deployed. The cloud entries describe the servers created by
// infra/aws_cluster.py and infra/azure_cluster.py; update them if the deployment changes.
export const INFRA = {
  cloud: {
    mum: {
      provider: 'AWS', service: 'EC2 instance', regionCode: 'ap-south-1', zone: 'Asia Pacific (Mumbai)',
      instance: 't3.micro', cpu: 'x86-64', os: 'Amazon Linux 2023', port: 8001,
    },
    hyd: {
      provider: 'AWS', service: 'EC2 instance', regionCode: 'ap-south-2', zone: 'Asia Pacific (Hyderabad)',
      instance: 't3.micro', cpu: 'x86-64', os: 'Amazon Linux 2023', port: 8002,
    },
    sin: {
      provider: 'Azure', service: 'Virtual machine', regionCode: 'southeastasia', zone: 'Southeast Asia (Singapore)',
      instance: 'Standard_B2ats_v2', cpu: 'x86-64 (AMD)', os: 'Ubuntu 24.04 LTS', port: 8003,
    },
  },
  local: {
    mum: { provider: 'Local', service: 'Process', regionCode: 'localhost:8001', zone: 'Simulated Mumbai', instance: 'This computer', cpu: 'Host CPU', os: 'Host OS', port: 8001 },
    hyd: { provider: 'Local', service: 'Process', regionCode: 'localhost:8002', zone: 'Simulated Hyderabad', instance: 'This computer', cpu: 'Host CPU', os: 'Host OS', port: 8002 },
    sin: { provider: 'Local', service: 'Process', regionCode: 'localhost:8003', zone: 'Simulated Singapore', instance: 'This computer', cpu: 'Host CPU', os: 'Host OS', port: 8003 },
  },
};

export const PROVIDER_COLOR = { AWS: '#ff9d1c', Azure: '#3b9dff', Local: '#8b95a7' };

// How a node gets from the repository to serving requests.
export const PIPELINE = [
  { step: 'Source', detail: 'Public GitHub repository, cloned by the server on first boot' },
  { step: 'Build', detail: 'Docker image built on the server from python:3.13-slim' },
  { step: 'Run', detail: 'One container per region, database on a persistent volume' },
  { step: 'Replicate', detail: 'Each node pulls what it is missing from its peers every 0.5 s' },
  { step: 'Protect', detail: 'Hash-chained events, admin token on fault and operator endpoints' },
];

export const STACK = ['AWS EC2', 'Azure VM', 'Docker', 'FastAPI', 'SQLite', 'SHA-256 hash chain', 'Hybrid logical clocks', 'Version vectors'];
