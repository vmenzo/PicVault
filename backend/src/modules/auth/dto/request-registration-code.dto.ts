import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

export class RequestRegistrationCodeDto {
  @ApiProperty({ example: 'admin@example.com' })
  @IsEmail()
  email: string;
}
