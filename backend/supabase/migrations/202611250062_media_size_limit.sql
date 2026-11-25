begin;

-- Images on posts: at most 1 MB each (was 5 MB in 0061). The app compresses before it uploads
-- (about 300 KB an image); the lower limit keeps a phone's original photo, ten times that, out of
-- the bucket, which is what storage and traffic are paid for.
update storage.buckets set file_size_limit = 1048576 where id = 'media';

commit;
