Adopting storage combinators to TS

https://hirschfeld.org/writings/media/WeiherHirschfeld_2019_StorageCombinators_AcmDL_Preprint.pdf


Check out how SerializeStore enables logging and stripping of metadata from http. 

Or how we use RelativeStore to add prefixes...Similar Store could be used to enforce prefixes.

Hard patterns that storage combinators make easy:
* Background checkpointing (as described in paper) with notifications of when checkpoints complete(my idea)
* Journalled storage, where one can write to a Store, but only serialize it via logging store to a file
* Then make a Store that wraps .get to read latest entry from ^
* Make a compacting Store out of ^
* Move ^ to S3 using S3 conditional put/get via etag
* Use S3 appends instead of ^ to optimize writes, but fallback to ^ on 10K write limit
* Mock storage for tests, dev and proper db backend in prod
