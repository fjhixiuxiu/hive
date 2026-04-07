# ALB for Hive dashboard — internet-facing, HTTPS only, office IPs restricted via SG.

resource "aws_lb" "hive" {
  name                       = "${var.hive_name}-alb"
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.hive_alb.id]
  subnets                    = var.subnet_ids
  enable_deletion_protection = true

  tags = {
    Name        = "${var.hive_name}-alb"
    environment = var.env_name
    customer    = var.customer_name
  }
}

resource "aws_lb_target_group" "hive" {
  name        = "${var.hive_name}-tg"
  port        = 3000
  protocol    = "HTTP"
  target_type = "instance"
  vpc_id      = var.vpc_id

  health_check {
    path                = "/"
    port                = "3000"
    protocol            = "HTTP"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
    matcher             = "200,302"
  }

  stickiness {
    type            = "lb_cookie"
    enabled         = true
    cookie_duration = 86400
  }

  tags = {
    Name        = "${var.hive_name}-tg"
    environment = var.env_name
    customer    = var.customer_name
  }
}

resource "aws_lb_listener" "hive_https" {
  load_balancer_arn = aws_lb.hive.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-Res-2021-06"
  certificate_arn   = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.hive.arn
  }
}

resource "aws_lb_listener" "hive_http_redirect" {
  load_balancer_arn = aws_lb.hive.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

# Register EC2 instance with target group
resource "aws_lb_target_group_attachment" "hive" {
  target_group_arn = aws_lb_target_group.hive.arn
  target_id        = aws_instance.hive.id
  port             = 3000
}
