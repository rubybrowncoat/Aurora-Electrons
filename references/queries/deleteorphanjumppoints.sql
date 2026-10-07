--find orphan jump points (usually happens after manually deleting a discovered system)
select 
	* 
from 
	FCT_JumpPoint as jp 
left join 
	FCT_JumpPoint as jp2
on
	jp2.WarpPointID = jp.WPLink
where 
	jp.GameID = 35 and jp.SystemID = 2098 and jp.WPLink <> 0
	
	
delete from FCT_JumpPoint where WarpPointID = 6012