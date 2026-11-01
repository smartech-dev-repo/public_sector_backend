import { Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AdminOnlyGuard } from '../auth/admin-only.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { NotificationService } from './notification.service';
import { ListNotificationsQueryDto } from './dto/list-notifications-query.dto';

@Controller('admin/notifications')
@UseGuards(JwtAuthGuard, AdminOnlyGuard)
export class AdminNotificationsController {
  constructor(private readonly notificationService: NotificationService) {}

  @Get()
  list(@Query() query: ListNotificationsQueryDto, @Req() req: { user: JwtPayload }) {
    return this.notificationService.list(
      req.user,
      { category: query.category, unread: query.unread },
      { page: query.page, limit: query.limit },
    );
  }

  @Get('summary')
  summary(@Req() req: { user: JwtPayload }) {
    return this.notificationService.summary(req.user);
  }

  // Declared before ':id/read' so it isn't read as a notification id.
  @Post('read-all')
  @HttpCode(200)
  async markAllRead(@Req() req: { user: JwtPayload }) {
    await this.notificationService.markAllRead(req.user);
    return { read: true };
  }

  @Post(':id/read')
  @HttpCode(200)
  async markRead(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    await this.notificationService.markRead(req.user, id);
    return { read: true };
  }
}
