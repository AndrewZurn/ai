variable "hetzner_token" {
  type      = string
  sensitive = true
}

variable "hetzner_ssh_key_id" {
  type = number
}

variable "tailscale_auth_key" {
  type      = string
  sensitive = true
}

variable "server_name" {
  type    = string
  default = "remote-devbox"
}

variable "server_label" {
  type    = string
  default = "remote-devbox"
}

variable "location" {
  type    = string
  default = "hil"
}

variable "server_type" {
  type    = string
  default = "cpx31"
}

variable "initial_image" {
  type    = string
  default = "ubuntu-24.04"
}
