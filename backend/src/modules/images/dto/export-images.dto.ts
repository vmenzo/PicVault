import { ArrayMaxSize, ArrayMinSize, IsArray, IsString } from 'class-validator';

export class ExportImagesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsString({ each: true })
  ids: string[];
}
