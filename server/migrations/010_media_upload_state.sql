ALTER TABLE media_objects DROP CONSTRAINT media_objects_status_check;
ALTER TABLE media_objects ADD CONSTRAINT media_objects_status_check CHECK (status IN ('uploading','ready','deleting'));
