SELECT
	*
FROM
	FCT_MissileSalvo as ms
where
	ms.MissileSalvoID BETWEEN 15796 and 15985
order by LaunchTime	
-- 306437842.615602	-65995260.1107358
-- 323689314.326261	79727886.1331667
-- to add -17251471.71	-145223146.2

/*
update FCT_MissileSalvo
set 
	xcor = xcor - 17251471.71
	,ycor = ycor - 145223146.2
where
	MissileSalvoID BETWEEN 15796 and 15985
*/

select * from FCT_Missile where SalvoID BETWEEN 15796 and 15985 order by SalvoID, MissileNumber

update FCT_Missile 
set 
	SalvoID = SalvoID-1
	,MissileNumber = CASE
		when SalvoID = 15797 then MissileNumber + (select max(MissileNumber) from fct_missile where SalvoID = 15796)
		else MissileNumber
	end
where SalvoID BETWEEN 15797 and 15985
