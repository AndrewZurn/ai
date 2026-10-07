terraform {
  required_version = ">= 1.6.0"

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.68"
    }
  }
}

provider "hcloud" {
  token = var.hetzner_token
}

resource "hcloud_primary_ip" "remote_machine" {
  name        = "${var.server_name}-ipv4"
  location    = var.location
  type        = "ipv4"
  auto_delete = false
}

resource "hcloud_server" "remote_machine" {
  name        = var.server_name
  location    = var.location
  server_type = var.server_type
  image       = var.initial_image
  ssh_keys    = [var.hetzner_ssh_key_id]
  labels      = { role = var.server_label }

  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    tailscale_auth_key = var.tailscale_auth_key
    server_label       = var.server_label
  })

  public_net {
    ipv4 = hcloud_primary_ip.remote_machine.id
  }

  lifecycle {
    ignore_changes = [user_data]
  }
}

resource "hcloud_firewall" "remote_machine" {
  name = "${var.server_name}-firewall"

  apply_to {
    label_selector = "role=${var.server_label}"
  }

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction       = "out"
    protocol        = "tcp"
    port            = "1-65535"
    destination_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction       = "out"
    protocol        = "udp"
    port            = "1-65535"
    destination_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction       = "out"
    protocol        = "icmp"
    destination_ips = ["0.0.0.0/0", "::/0"]
  }
}

output "droplet_id" {
  value = hcloud_server.remote_machine.id
}

output "droplet_ip" {
  value = hcloud_primary_ip.remote_machine.ip_address
}

output "primary_ip_id" {
  value = hcloud_primary_ip.remote_machine.id
}
