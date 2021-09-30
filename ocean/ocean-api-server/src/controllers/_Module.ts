import { CacheModule, Module } from '@nestjs/common'
import { ActuatorController } from './ActuatorController'
import { FeeController } from './FeeController'
import { APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core'

/**
 * Exposed ApiModule for public interfacing
 */
@Module({
  imports: [CacheModule.register()],
  controllers: [
    ActuatorController,
    FeeController,
  ],
  providers: [
    {
      provide: APP_PIPE,
      useClass: ApiValidationPipe
    },
    // APP_INTERCEPTOR are only activated for /v* paths
    {
      provide: APP_INTERCEPTOR,
      useClass: ResponseInterceptor
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: ExceptionInterceptor
    },
    {
      provide: 'NETWORK_NAME',
      useFactory: (configService: ConfigService): NetworkName => {
        return configService.get<string>('network') as NetworkName
      },
      inject: [ConfigService]
    }
  ]
})
export class ControllerModule {
}
