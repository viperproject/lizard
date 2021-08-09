export const collect = <T extends unknown>(xs: T | undefined): Array<T> => 
    (xs===undefined) ? [] : [xs]
