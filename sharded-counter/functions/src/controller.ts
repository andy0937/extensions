import { firestore } from "firebase-admin";
import { Slice, WorkerStats, queryRange } from "./common";

export interface WorkerShardingInfo {
    slice: Slice
    hasData: boolean
    overloaded: boolean
    splits: string[]
}

export class ShardedCounterController {
    private workersRef: firestore.CollectionReference;
    private db: firestore.Firestore;
    constructor(metadocRef: firestore.DocumentReference, private shardCollection: string, private minWorkers: number) {
        if (metadocRef) {
            this.workersRef = metadocRef.collection('workers');
            this.db = metadocRef.firestore;
        }
    }

    public async run() {
        const timestamp = Date.now();

        await this.db.runTransaction(async (t) => {
            let query = await t.get(this.workersRef.orderBy(firestore.FieldPath.documentId()));
            let shardingInfo: WorkerShardingInfo[] = await Promise.all(query.docs.map(async (worker) => {
                const slice: Slice = worker.get('slice');
                const stats: WorkerStats = worker.get('stats');
                if (!stats) return {slice: slice, hasData: false, overloaded: false, splits: []};

                const hasData = true;
                const overloaded = (stats.rounds === stats.roundsCapped);
                const splits = stats.splits;
                if (overloaded && splits.length > 0) {
                    const snap = await queryRange(this.db, this.shardCollection, splits[splits.length - 1], slice.end, 100000).get();
                    console.log("Pulled extra " + snap.docs.length + " shard keys");
                    for (let i = 100; i < snap.docs.length; i += 100) {
                        splits.push(snap.docs[i].ref.path);
                    }
                }
                return {slice, hasData, overloaded, splits};
            }));

            let [reshard, slices] = ShardedCounterController.balanceWorkers(shardingInfo, this.minWorkers);
            if (reshard) {
                console.log("Resharding workers, num slices: " + slices.length + " prev num workers: " + query.docs.length);
                query.docs.forEach((snap) => t.delete(snap.ref));
                slices.forEach((slice, index) => {
                    t.set(this.workersRef.doc(ShardedCounterController.encodeWorkerKey(index)), {
                        slice: slice,
                        timestamp: timestamp,
                        opts: {
                            shardsThreshold: { lo: 499, hi: 499},
                            aggregationInterval: 1000,
                            statSplitSize: 100,
                            transactionSize: 500,
                            shardCollectionName: this.shardCollection
                        }
                    })
                })
            } else {
                const timestamp = Date.now();
                let failures = 0;
                query.docs.forEach((snap) => {
                    if ((timestamp / 1000) - snap.updateTime.seconds > 90) {
                        t.set(snap.ref, {timestamp: timestamp}, {merge: true});
                        failures++;
                    }
                });
                console.log("Detected " + failures + " failed workers.")
            }
        });
    }

    protected static balanceWorkers(workers: WorkerShardingInfo[], minWorkers: number): [boolean, Slice[]] {
        if (workers.length === 0) {
            if (minWorkers > 0) {
                return [true, [{
                    start: '/experiment/counter4/_counter_shards_/\t',
                    end: '/experiment/counter4/_counter_shards_/z'
                }]];
            } else {
                return [false, []];
            }
        }
        let splits: string[] = [];
        let reshard = false;
        for (let i = 0; i < workers.length; i++) {
            let worker = workers[i];
            if (!worker.hasData) return [false, []];   
    
            splits.push(worker.slice.start);
            splits = splits.concat(worker.splits || []);
            if (worker.overloaded) reshard = true;
    
            if (i === (workers.length - 1)) {
                splits.push(worker.slice.end);
            }
        }
        if (splits.length < 10 * workers.length && workers.length > 1) reshard = true;
        if (splits.length <= 2 && minWorkers === 0) return [true, []];
    
        let slices: Slice[] = [];
        for (let i = 0; i < (splits.length - 1); i += 20) {
            slices.push({
                start: splits[i],
                end: splits[Math.min(i + 20, splits.length - 1)]
            });
        }
        return [reshard, slices];
    }
    
    protected static encodeWorkerKey(idx: number): string {
        let key = idx.toString(16);
        while (key.length < 4) key = '0' + key;
        return key;
    }
}


