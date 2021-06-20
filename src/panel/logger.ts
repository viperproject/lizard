

export class Logger {

    private static log(prefix: string, message: string): void {
        if (prefix === 'error') {
            console.error(`[panel:${prefix}] ${message}`)
        } else {
            console.log(`[panel:${prefix}] ${message}`)
        }
    }

    public static info(message: string): void {
        Logger.log('info', message)
    }

    public static debug(message: string): void {
        Logger.log('debug', message)
    }

    public static error(message: string): void {
        Logger.log('error', message)
    }
}